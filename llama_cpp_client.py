"""llama-server client that routes requests between Spark-X2.6-4B and LFM3-1.7B and toggles thinking per request."""

import json
import re
import time
import urllib.request
from typing import Any, Callable, Dict, List, Optional, Tuple

MODELS = {
    "spark": {"name": "Spark-X2.6-4B", "url": "http://127.0.0.1:8080"},
    "lfm3": {"name": "LFM3-1.7B", "url": "http://127.0.0.1:8081"},
}
CODE_BLOCK = re.compile(r"```(?:python)?\s*(.*?)\s*```", re.DOTALL)


def extract_code(text: str) -> str:
    """Returns the first fenced code block in text, or the whole text if there is none."""
    blocks = CODE_BLOCK.findall(text)
    return (blocks[0] if blocks else text).strip()


class AutoThinkingPolicy:
    """Thinking is off for code and schema output, and on for diagnosis, planning, and retries after a test failure."""

    RETRY_SIGNALS = ("assert", "traceback", "error[", "mismatched", "cannot borrow", "failed")

    @classmethod
    def resolve(cls, mode="auto", task_intent="code", has_schema=False, is_retry=False, prompt="") -> bool:
        if mode in (True, "on"):
            return True
        if mode in (False, "off"):
            return False
        if has_schema:
            return False
        if is_retry and any(s in prompt.lower() for s in cls.RETRY_SIGNALS):
            return True
        return task_intent in ("diagnosis", "reasoning", "trace_analysis", "planning")


class AutoModelPolicy:
    """Mode "spark" or "lfm3" forces a model. In "auto", short patching and scouting tasks go to LFM3, everything else to Spark."""

    LFM3_INTENTS = ("micro_patch", "completion", "fencepost", "scout", "schema", "swarm_worker")

    @classmethod
    def resolve(cls, mode="auto", task_intent="code", context_needed=2048) -> str:
        if mode in MODELS:
            return mode
        if context_needed <= 131072 and task_intent in cls.LFM3_INTENTS:
            return "lfm3"
        return "spark"


class LlamaCppClient:
    def __init__(self, thinking_mode="auto", model_mode="auto", timeout=45.0):
        self.thinking_mode = thinking_mode
        self.model_mode = model_mode
        self.timeout = timeout

    @staticmethod
    def check_health(model: str) -> bool:
        try:
            with urllib.request.urlopen(f"{MODELS[model]['url']}/health", timeout=4.0) as resp:
                return json.load(resp).get("status") == "ok"
        except (OSError, ValueError):
            return False

    def resolve_model(self, task_intent="code", context_needed=2048) -> str:
        """Applies AutoModelPolicy. In auto mode, falls back to the other model when the chosen server is down."""
        model = AutoModelPolicy.resolve(self.model_mode, task_intent, context_needed)
        if self.model_mode == "auto" and not self.check_health(model):
            return "lfm3" if model == "spark" else "spark"
        return model

    def _post(self, model: str, path: str, payload: Dict[str, Any], parse: Callable[[Dict], Tuple[str, int]]) -> Dict[str, Any]:
        req = urllib.request.Request(
            MODELS[model]["url"] + path,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        t0 = time.time()
        error = None
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                content, tokens = parse(json.load(resp))
        except (OSError, ValueError, KeyError, IndexError) as e:
            content, tokens, error = "", 0, str(e)
        elapsed = time.time() - t0
        return {
            "success": error is None,
            "error": error,
            "model": model,
            "content": content,
            "tokens": tokens,
            "elapsed_sec": round(elapsed, 3),
            "tokens_per_sec": round(tokens / elapsed, 2) if elapsed else 0.0,
        }

    def chat(self, messages: List[Dict[str, str]], max_tokens=600, response_format=None, task_intent="code",
             enable_thinking: Optional[bool] = None, model: Optional[str] = None) -> Dict[str, Any]:
        """OpenAI-style chat. Thinking follows AutoThinkingPolicy and the model follows resolve_model unless given."""
        if enable_thinking is None:
            enable_thinking = AutoThinkingPolicy.resolve(self.thinking_mode, task_intent, bool(response_format))
        payload = {
            "messages": messages,
            "temperature": 0.0,
            "max_tokens": max_tokens,
            "chat_template_kwargs": {"enable_thinking": enable_thinking},
        }
        if response_format:
            payload["response_format"] = response_format
        return self._post(
            model or self.resolve_model(task_intent, max_tokens * 2),
            "/v1/chat/completions",
            payload,
            lambda b: ((b["choices"][0]["message"].get("content") or "").strip(), b.get("usage", {}).get("completion_tokens", 0)),
        )

    def chat_json(self, messages: List[Dict[str, str]], schema: Dict[str, Any], max_tokens=300) -> Optional[Dict[str, Any]]:
        """Chat constrained to a JSON schema. Returns the parsed object, or None on failure."""
        res = self.chat(messages, max_tokens, response_format={"type": "json_object", "schema": schema})
        try:
            return json.loads(res["content"])
        except ValueError:
            return None

    def completion(self, prompt: str, n_predict: int, stop: List[str]) -> Dict[str, Any]:
        """Raw LFM3 /completion call, used for pre-filled ChatML prompts."""
        return self._post(
            "lfm3",
            "/completion",
            {"prompt": prompt, "n_predict": n_predict, "temperature": 0.0, "stop": stop},
            lambda b: (b["content"], b.get("tokens_predicted", 0)),
        )

    def generate_code(self, model: str, system: str, user: str, instruction: str, prefill="", think=False,
                      max_tokens=450) -> Tuple[str, Dict[str, Any]]:
        """
        Asks for corrected code and returns (code, raw result).
        Spark gets a chat request with `instruction` appended. LFM3 gets a ChatML prompt whose assistant turn is
        pre-filled with an open code block and `prefill`, or with an open <think> block (and twice the tokens) when
        `think` is set.
        """
        if model == "spark":
            messages = [{"role": "system", "content": system}, {"role": "user", "content": f"{user}\n\n{instruction}"}]
            res = self.chat(messages, max_tokens, enable_thinking=think, model="spark")
            return extract_code(res["content"]), res

        turns = f"<|im_start|>system\n{system}\n<|im_end|>\n<|im_start|>user\n{user}\n<|im_end|>\n<|im_start|>assistant\n"
        if not think:
            res = self.completion(f"{turns}```python\n{prefill}", max_tokens, ["```", "<|im_end|>", "<|endoftext|>"])
            return prefill + res["content"], res

        res = self.completion(f"{turns}<think>\n", max_tokens * 2, ["<|im_end|>", "<|endoftext|>"])
        code = extract_code(res["content"])
        if prefill.startswith("def ") and not code.startswith("def "):
            code = f"{prefill}\n{code}"
        return code, res
