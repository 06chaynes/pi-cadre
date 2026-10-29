"""
High-Performance Llama.cpp Client for Swarm Agents.
Connects to llama-server on port 8080 (Metal-accelerated GGUF execution).
Features:
- OpenAI-compatible /v1/chat/completions
- GBNF Grammar and JSON Schema structured decoding
- Native separation of reasoning_content vs content
- Generation latency and tokens/sec telemetry
"""

import urllib.request
import urllib.error
import json
import time
import socket
from typing import Dict, Any, List, Optional, Union

socket.setdefaulttimeout(40.0)

class AutoThinkingPolicy:
    """
    Intelligent Auto-Thinking Policy for LFM3 Swarm Agents.
    Decides when thinking (<think>...</think>) should be enabled vs disabled:
    - Code Synthesis & Micro-Editing: OFF (steered via prefix pre-fill to avoid token budget exhaustion).
    - Structured Schemas (JSON/GBNF): OFF (guarantees valid first-token JSON compliance).
    - Complex Diagnosis / Root-Cause Planning: ON (allows exploratory reasoning paths).
    - Execution-Feedback Retries: ON when complex logic tracebacks are detected.
    """
    @staticmethod
    def resolve(
        mode: Union[str, bool] = "auto",
        task_intent: str = "code",
        has_schema: bool = False,
        is_retry: bool = False,
        prompt: str = ""
    ) -> bool:
        if mode in (True, "on", "true", "True"):
            return True
        if mode in (False, "off", "false", "False"):
            return False

        # "auto" resolution logic
        if has_schema:
            return False
        if is_retry and (
            "assert" in prompt.lower()
            or "traceback" in prompt.lower()
            or "error[" in prompt.lower()
            or "mismatched" in prompt.lower()
            or "cannot borrow" in prompt.lower()
            or "failed" in prompt.lower()
        ):
            return True
        if task_intent in ("code", "synthesis", "micro_patch", "completion"):
            return False
        if task_intent in ("diagnosis", "reasoning", "trace_analysis", "planning"):
            return True
        return False

class AutoContextPolicy:
    """
    Intelligent Auto-Context Policy for Swarm Agents & Pi Assistant (LFM3 & Spark-X2.6).
    Dynamically sizes context allocation and generation token headroom based on task complexity:
    - Tier 1: Micro / Patch (single function, 2,048 tokens).
    - Tier 2: Module / Intra-file context with tests (8,192 tokens).
    - Tier 3: Multi-file / Call Graph & Architecture (32,768 tokens).
    - Tier 4: Cross-crate / Subsystem Integration (65,536 tokens).
    - Tier 5: Deep Codebase (131,072 tokens).
    - Tier 6: Monorepo Log / Audit (262,144 tokens - LFM3 native ceiling).
    - Tier 7: Extended Monorepo Audit (524,288 tokens).
    - Tier 8: Full Codebase 1M Ingestion (1,048,576 tokens - Spark-X2.6 native ceiling).
    """
    TIERS = [
        (1500, 2048, 512, "Tier 1: Micro Patch (2k)"),
        (6000, 8192, 1024, "Tier 2: Module Context (8k)"),
        (24000, 32768, 2048, "Tier 3: Call Graph / Multi-File (32k)"),
        (50000, 65536, 4096, "Tier 4: Subsystem / Integration (64k)"),
        (100000, 131072, 8192, "Tier 5: Deep Codebase (128k)"),
        (350000, 262144, 8192, "Tier 6: Full Monorepo (256k)"),
        (600000, 524288, 16384, "Tier 7: Extended Monorepo Audit (512k)"),
        (1200000, 1048576, 16384, "Tier 8: Ultra 1M Codebase Ingestion (1M)")
    ]

    @classmethod
    def resolve(
        cls,
        mode: Union[str, int] = "auto",
        prompt: str = "",
        task_intent: str = "code",
        file_count: int = 1,
        max_model_ctx: int = 1048576
    ) -> Dict[str, Any]:
        """
        Resolves context size and recommended n_predict token budget.
        Returns: { 'ctx_size': int, 'n_predict': int, 'tier': str, 'mode': str }
        """
        # Explicit override
        if mode not in ("auto", "Auto", None):
            if isinstance(mode, int):
                ctx = mode
            else:
                m = str(mode).lower().strip()
                if m in ("1m", "1024k"):
                    ctx = 1048576
                elif m.endswith("m"):
                    try:
                        ctx = int(float(m[:-1]) * 1000000)
                    except ValueError:
                        ctx = 1048576
                elif m.endswith("k"):
                    try:
                        ctx = int(float(m[:-1]) * 1000)
                    except ValueError:
                        ctx = 32768
                else:
                    try:
                        ctx = int(m)
                    except ValueError:
                        ctx = 32768
            clamped_ctx = min(ctx, max_model_ctx)
            return {
                "ctx_size": clamped_ctx,
                "n_predict": min(max(512, clamped_ctx // 4), 16384),
                "tier": f"Manual Override ({clamped_ctx} tokens)",
                "mode": "override"
            }

        # Auto resolution
        est_tokens = len(prompt) // 4  # ~4 chars per token approximation

        # Boost tier based on task complexity
        if task_intent in ("repo_wide", "audit", "trace_analysis"):
            est_tokens = max(est_tokens, 50000)
        elif task_intent in ("subsystem", "architecture"):
            est_tokens = max(est_tokens, 25000)
        elif task_intent in ("call_graph", "multi_file") or file_count > 3:
            est_tokens = max(est_tokens, 10000)
        elif task_intent in ("diagnosis", "planning"):
            est_tokens = max(est_tokens, 3000)

        for token_threshold, target_ctx, n_pred, label in cls.TIERS:
            if est_tokens <= token_threshold:
                clamped_ctx = min(target_ctx, max_model_ctx)
                return {
                    "ctx_size": clamped_ctx,
                    "n_predict": min(n_pred, max(512, clamped_ctx // 4)),
                    "tier": label,
                    "mode": "auto"
                }

        # Default fallback to max model ctx
        clamped_ctx = max_model_ctx
        return {
            "ctx_size": clamped_ctx,
            "n_predict": 16384 if clamped_ctx >= 524288 else 8192,
            "tier": f"Maximum Context ({clamped_ctx // 1024}k)",
            "mode": "auto"
        }

class LlamaCppClient:
    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8080",
        model: str = "models/Spark-X2.6-4B-Q4_K_M.gguf",
        timeout: float = 45.0,
        thinking_mode: Union[str, bool] = "auto",
        context_mode: Union[str, int] = "auto",
        model_family: Optional[str] = None
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.thinking_mode = thinking_mode
        self.context_mode = context_mode
        self.policy = AutoThinkingPolicy()
        self.context_policy = AutoContextPolicy()
        
        # Detect model family and context ceiling
        if model_family:
            self.model_family = model_family.lower()
        elif "spark" in model.lower():
            self.model_family = "spark"
        else:
            self.model_family = "lfm3"

        self.max_model_ctx = 1048576 if self.model_family == "spark" else 262144

    def check_health(self) -> bool:
        try:
            req = urllib.request.Request(f"{self.base_url}/health")
            with urllib.request.urlopen(req, timeout=5.0) as resp:
                data = json.loads(resp.read().decode())
                return data.get("status") == "ok"
        except Exception:
            return False

    def chat(
        self,
        messages: List[Dict[str, str]],
        temperature: float = 0.0,
        max_tokens: int = 600,
        response_format: Optional[Dict[str, Any]] = None,
        grammar: Optional[str] = None,
        task_intent: str = "code",
        is_retry: bool = False,
        enable_thinking: Optional[bool] = None
    ) -> Dict[str, Any]:
        """
        Sends chat completion request to llama-server.
        Supports native thinking resolution and chat_template_kwargs toggling.
        """
        if enable_thinking is None:
            last_prompt = messages[-1].get("content", "") if messages else ""
            enable_thinking = self.policy.resolve(
                mode=self.thinking_mode,
                task_intent=task_intent,
                has_schema=bool(response_format),
                is_retry=is_retry,
                prompt=last_prompt
            )

        payload: Dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
            "chat_template_kwargs": {"enable_thinking": enable_thinking}
        }
        if response_format:
            payload["response_format"] = response_format
        if grammar:
            payload["grammar"] = grammar

        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}/v1/chat/completions",
            data=data,
            headers={"Content-Type": "application/json"}
        )

        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw_body = resp.read().decode("utf-8")
                res = json.loads(raw_body)
                elapsed = time.time() - t0

                choice = res.get("choices", [{}])[0]
                msg = choice.get("message", {})
                content = msg.get("content", "").strip()
                reasoning = msg.get("reasoning_content", "")
                
                usage = res.get("usage", {})
                completion_tokens = usage.get("completion_tokens", 0)
                tok_per_sec = (completion_tokens / elapsed) if elapsed > 0 else 0.0

                return {
                    "success": True,
                    "content": content,
                    "reasoning": reasoning,
                    "elapsed_sec": round(elapsed, 3),
                    "tokens": completion_tokens,
                    "tokens_per_sec": round(tok_per_sec, 2),
                    "error": None
                }
        except Exception as e:
            elapsed = time.time() - t0
            return {
                "success": False,
                "content": "",
                "reasoning": "",
                "elapsed_sec": round(elapsed, 3),
                "tokens": 0,
                "tokens_per_sec": 0.0,
                "error": str(e)
            }

    def completion(
        self,
        prompt: str,
        n_predict: int = 500,
        temperature: float = 0.0,
        stop: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """
        Direct native completion endpoint with prefix pre-filling support.
        Bypasses thinking token latency and conversational preambles.
        """
        payload: Dict[str, Any] = {
            "prompt": prompt,
            "n_predict": n_predict,
            "temperature": temperature,
            "stream": False
        }
        if stop:
            payload["stop"] = stop
        else:
            payload["stop"] = ["```", "<|im_end|>", "<|endoftext|>"]

        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}/completion",
            data=data,
            headers={"Content-Type": "application/json"}
        )

        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                res = json.loads(resp.read().decode("utf-8"))
                elapsed = time.time() - t0
                content = res.get("content", "")
                tokens = res.get("tokens_predicted", 0)
                tok_per_sec = (tokens / elapsed) if elapsed > 0 else 0.0
                return {
                    "success": True,
                    "content": content,
                    "tokens": tokens,
                    "elapsed_sec": round(elapsed, 3),
                    "tokens_per_sec": round(tok_per_sec, 2),
                    "error": None
                }
        except Exception as e:
            elapsed = time.time() - t0
            return {
                "success": False,
                "content": "",
                "tokens": 0,
                "elapsed_sec": round(elapsed, 3),
                "tokens_per_sec": 0.0,
                "error": str(e)
            }

    def chat_structured(
        self,
        messages: List[Dict[str, str]],
        schema: Dict[str, Any],
        max_tokens: int = 300
    ) -> Dict[str, Any]:
        """
        Structured JSON decoding using llama-server's native JSON Schema support.
        """
        res = self.chat(
            messages=messages,
            temperature=0.0,
            max_tokens=max_tokens,
            response_format={
                "type": "json_object",
                "schema": schema
            }
        )
        if not res["success"]:
            return {"success": False, "valid_json": False, "parsed": None, "error": res["error"]}

        content = res["content"]
        # If content is empty because reasoning_content absorbed output, check reasoning
        if not content and res.get("reasoning"):
            import re
            m = re.search(r"\{.*\}", res["reasoning"], re.DOTALL)
            if m:
                content = m.group(0)

        try:
            parsed = json.loads(content)
            return {"success": True, "valid_json": True, "parsed": parsed, "raw": content, "elapsed_sec": res["elapsed_sec"]}
        except Exception as e:
            return {"success": False, "valid_json": False, "parsed": None, "raw": content, "error": str(e), "elapsed_sec": res["elapsed_sec"]}
