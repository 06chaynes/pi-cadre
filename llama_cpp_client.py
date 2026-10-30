"""llama-server client that routes requests between Spark-X2.6-4B and LFM3-1.7B and toggles thinking per request."""

import ast
import json
import math
import re
import textwrap
import time
import urllib.request
from typing import Any, Callable, Dict, List, Optional, Tuple

MODELS = {
    "spark": {"name": "Spark-X2.6-4B", "url": "http://127.0.0.1:8080"},
    "lfm3": {"name": "LFM3-1.7B", "url": "http://127.0.0.1:8081"},
}
CODE_BLOCK = re.compile(r"```(?:python)?\s*(.*?)\s*(?:```|\Z)", re.DOTALL)
THINK_END = "</think>"
REPAIR_LOOKBACK = 4
REPAIR_ALTERNATIVES = 2


def code_span(text: str) -> Tuple[int, int]:
    """
    Returns (start, end) of the code in text: the first fenced block after any closing </think> tag (an unclosed
    fence runs to the end), or all text after that tag when there is no fence. Surrounding whitespace is excluded.
    """
    base = text.rfind(THINK_END)
    base = base + len(THINK_END) if base >= 0 else 0
    match = CODE_BLOCK.search(text, base)
    start, end = match.span(1) if match else (base, len(text))
    while start < end and text[start].isspace():
        start += 1
    while end > start and text[end - 1].isspace():
        end -= 1
    return start, end


def extract_code(text: str) -> str:
    """Returns the code located by code_span."""
    start, end = code_span(text)
    return text[start:end]


def syntax_error(code: str) -> Optional[SyntaxError]:
    """
    Returns None if code parses as a module or as a function body, otherwise the module-level SyntaxError.
    Its line and column refer to textwrap.dedent(code).
    """
    code = textwrap.dedent(code)
    try:
        ast.parse(code)
        return None
    except SyntaxError as e:
        error = e
    try:
        ast.parse("def _f():\n" + textwrap.indent(code, "    "))
        return None
    except SyntaxError:
        return error


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

    def _post(self, model: str, path: str, payload: Dict[str, Any], parse: Callable[[Dict], Dict[str, Any]]) -> Dict[str, Any]:
        req = urllib.request.Request(
            MODELS[model]["url"] + path,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        t0 = time.time()
        error = None
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                parsed = parse(json.load(resp))
        except (OSError, ValueError, KeyError, IndexError) as e:
            parsed, error = {"content": "", "tokens": 0}, str(e)
        elapsed = time.time() - t0
        return {
            "success": error is None,
            "error": error,
            "model": model,
            **parsed,
            "elapsed_sec": round(elapsed, 3),
            "tokens_per_sec": round(parsed["tokens"] / elapsed, 2) if elapsed else 0.0,
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
            lambda b: {
                "content": (b["choices"][0]["message"].get("content") or "").strip(),
                "tokens": b.get("usage", {}).get("completion_tokens", 0),
            },
        )

    def chat_json(self, messages: List[Dict[str, str]], schema: Dict[str, Any], max_tokens=300,
                  task_intent="schema") -> Optional[Dict[str, Any]]:
        """
        Chat constrained to a JSON schema. The last message gets a line naming the schema's fields, so the model
        is not forced by the grammar into fields it was not asked for. Returns the parsed object, or None on failure.
        """
        fields = ", ".join(schema.get("properties", {}))
        last = messages[-1]
        messages = messages[:-1] + [{**last, "content": f"{last['content']}\n\nRespond with a JSON object containing exactly these fields: {fields}."}]
        res = self.chat(messages, max_tokens, response_format={"type": "json_object", "schema": schema}, task_intent=task_intent)
        try:
            return json.loads(res["content"])
        except ValueError:
            return None

    def apply_template(self, model: str, messages: List[Dict[str, str]], think: bool) -> str:
        """Renders messages with the server's chat template, ending at the start of the assistant turn."""
        res = self._post(
            model,
            "/apply-template",
            {"messages": messages, "chat_template_kwargs": {"enable_thinking": think}},
            lambda b: {"content": b["prompt"], "tokens": 0},
        )
        return res["content"]

    def completion(self, model: str, prompt: str, n_predict: int, stop: List[str]) -> Dict[str, Any]:
        """Raw /completion call. The result's "probs" holds each generated token with its top alternatives."""
        return self._post(
            model,
            "/completion",
            {"prompt": prompt, "n_predict": n_predict, "temperature": 0.0, "stop": stop, "n_probs": 5},
            lambda b: {
                "content": b["content"],
                "tokens": b.get("tokens_predicted", 0),
                "probs": b.get("completion_probabilities", []),
            },
        )

    def _repair_syntax(self, model: str, prompt: str, head: str, res: Dict[str, Any], n_predict: int,
                       stop: List[str]) -> Dict[str, Any]:
        """
        If the code in head + res["content"] does not parse, regenerates from one of the last REPAIR_LOOKBACK tokens
        at or before the error position, forcing one of that token's top alternatives instead. Returns the first
        result whose code parses, or res unchanged. Fixes errors the model makes with high confidence (for example
        the merged "):" token closing a multi-line condition), which feedback and resampling repeat.
        """
        text = head + res["content"]
        start, end = code_span(text)
        code = text[start:end]
        error = syntax_error(code)
        if error is None or not res.get("probs") or not error.lineno:
            return res

        lines, dedented = code.splitlines(), textwrap.dedent(code).splitlines()
        row = min(error.lineno, len(lines)) - 1
        col = (error.offset or 1) - 1 + len(lines[row]) - len(dedented[row])
        error_pos = start + sum(len(line) + 1 for line in lines[:row]) + col - len(head)

        offsets, pos = [], 0
        for tok in res["probs"]:
            offsets.append(pos)
            pos += len(tok["token"])
        candidates = [i for i, offset in enumerate(offsets) if offset <= error_pos][-REPAIR_LOOKBACK:]
        for i in reversed(candidates):
            chosen = res["probs"][i]
            alternatives = [a for a in chosen["top_logprobs"] if a["token"] != chosen["token"]][:REPAIR_ALTERNATIVES]
            for alt in alternatives:
                prefix = res["content"][:offsets[i]] + alt["token"]
                cont = self.completion(model, prompt + head + prefix, n_predict, stop)
                if syntax_error(extract_code(head + prefix + cont["content"])) is None:
                    return {**cont, "content": prefix + cont["content"], "tokens": res["tokens"] + cont["tokens"],
                            "repaired": True, "repair": f"{chosen['token']!r} -> {alt['token']!r} (p={math.exp(alt['logprob']):.3f})"}
        return res

    def generate_code(self, model: str, system: str, user: str, instruction: str, prefill="", think=False,
                      max_tokens=450) -> Tuple[str, Dict[str, Any]]:
        """
        Asks for corrected code and returns (code, raw result). Output that does not parse goes through
        _repair_syntax; res["repaired"] says whether that changed it.
        Spark gets its chat template with `instruction` appended to the user turn. LFM3 gets a ChatML prompt whose
        assistant turn is pre-filled with an open code block and `prefill`, or with an open <think> block (and
        twice the tokens) when `think` is set.
        """
        if model == "spark":
            messages = [{"role": "system", "content": system}, {"role": "user", "content": f"{user}\n\n{instruction}"}]
            prompt, head, n_predict, stop = self.apply_template("spark", messages, think), "", max_tokens, []
        else:
            prompt = f"<|im_start|>system\n{system}\n<|im_end|>\n<|im_start|>user\n{user}\n<|im_end|>\n<|im_start|>assistant\n"
            if think:
                head, n_predict, stop = "<think>\n", max_tokens * 2, ["<|im_end|>", "<|endoftext|>"]
            else:
                head, n_predict, stop = f"```python\n{prefill}", max_tokens, ["```", "<|im_end|>", "<|endoftext|>"]

        first = self.completion(model, prompt + head, n_predict, stop)
        res = self._repair_syntax(model, prompt, head, first, n_predict, stop)
        res["repaired"] = res is not first
        code = extract_code(head + res["content"])
        if think and prefill.startswith("def ") and not code.startswith("def "):
            code = f"{prefill}\n{code}"
        return code, res
