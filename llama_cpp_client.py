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
    Intelligent Auto-Thinking Policy for Multi-Model Swarm Agents (LFM3 & Spark-X2.6).
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

class AutoModelPolicy:
    """
    Intelligent Model Selection Policy for Multi-Model Swarms.
    Selects between:
      1. Spark-X2.6-4B (port 8080): 4.0B params, 1M context, deep multi-step reasoning, tool use.
      2. LFM3-1.7B (port 8081): 1.7B params, 256k context, ultra-fast linear SSM micro-patching (0.4s).
    Supports:
      - Global override: mode="spark" or mode="lfm3"
      - Auto mode: mode="auto" (dynamically selects the optimal model based on latency vs reasoning depth)
    """
    SPARK_CONFIG = {
        "id": "spark",
        "name": "Spark-X2.6-4B",
        "port": 8080,
        "base_url": "http://127.0.0.1:8080",
        "max_context": 1048576,
        "default_slots": 8
    }
    LFM3_CONFIG = {
        "id": "lfm3",
        "name": "LFM3-1.7B",
        "port": 8081,
        "base_url": "http://127.0.0.1:8081",
        "max_context": 262144,
        "default_slots": 16
    }

    @classmethod
    def resolve(
        cls,
        mode: str = "auto",
        task_intent: str = "code",
        context_needed: int = 2048,
        is_micro_patch: bool = False,
        requires_deep_reasoning: bool = False,
        prompt: str = ""
    ) -> Dict[str, Any]:
        # Global override
        m = str(mode or "auto").lower().strip()
        if m in ("spark", "spark-4b", "spark2.6", "spark2_6"):
            return {**cls.SPARK_CONFIG, "selection_reason": "Global Override (Spark-X2.6-4B)", "mode": "override"}
        if m in ("lfm3", "lfm", "lfm3-1.7b"):
            return {**cls.LFM3_CONFIG, "selection_reason": "Global Override (LFM3-1.7B)", "mode": "override"}

        # Auto resolution
        # 1. Massive context requirements (>131k tokens up to 1M) -> Spark-X2.6-4B
        if context_needed > 131072:
            return {**cls.SPARK_CONFIG, "selection_reason": f"High Context Requirement ({context_needed} tokens > 131k)", "mode": "auto"}

        # 2. Ultra-low latency micro-patching (<2k tokens, prefix prefill, fencepost bug fixes) -> LFM3-1.7B
        if is_micro_patch or task_intent in ("micro_patch", "completion", "fencepost"):
            return {**cls.LFM3_CONFIG, "selection_reason": "Ultra-Low Latency Micro-Patching (SSM Linear Attention)", "mode": "auto"}

        # 3. High-level architecture, diagnostic self-healing, multi-step planning -> Spark-X2.6-4B
        if requires_deep_reasoning or task_intent in ("architecture", "diagnosis", "planning", "root_cause", "trace_analysis"):
            return {**cls.SPARK_CONFIG, "selection_reason": "Deep Multi-Step Reasoning & Root-Cause Diagnosis", "mode": "auto"}

        # 4. High-throughput swarm routines (AST symbol scanning, structured schema decoding) -> LFM3-1.7B
        if task_intent in ("scout", "schema", "swarm_worker"):
            return {**cls.LFM3_CONFIG, "selection_reason": "High-Throughput Swarm Scout & Schema Decoding (16 parallel slots)", "mode": "auto"}

        # Default: Spark-X2.6-4B for general software engineering and multi-file synthesis
        return {**cls.SPARK_CONFIG, "selection_reason": "Balanced General Coding & Agent Synthesis", "mode": "auto"}

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
        model_mode: str = "auto",
        model_family: Optional[str] = None
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.thinking_mode = thinking_mode
        self.context_mode = context_mode
        self.model_mode = model_mode
        self.policy = AutoThinkingPolicy()
        self.context_policy = AutoContextPolicy()
        self.model_policy = AutoModelPolicy()

        self.endpoints = {
            "spark": "http://127.0.0.1:8080",
            "lfm3": "http://127.0.0.1:8081"
        }
        
        # Detect model family and context ceiling
        if model_family:
            self.model_family = model_family.lower()
        elif "spark" in model.lower():
            self.model_family = "spark"
        else:
            self.model_family = "lfm3"

        self.max_model_ctx = 1048576 if self.model_family == "spark" else 262144

    def check_health(self, url: Optional[str] = None) -> bool:
        target = (url or self.base_url).rstrip("/")
        try:
            req = urllib.request.Request(f"{target}/health")
            with urllib.request.urlopen(req, timeout=4.0) as resp:
                data = json.loads(resp.read().decode())
                return data.get("status") == "ok"
        except Exception:
            return False

    def ensure_servers(self, required_models: Optional[List[str]] = None) -> Dict[str, bool]:
        """
        Automatically verifies and boots required llama-server instances if offline.
        Provides a single-click seamless execution experience.
        """
        import subprocess
        needed = required_models or (["spark", "lfm3"] if self.model_mode == "auto" else [self.model_mode])
        status = {}

        for m in needed:
            m_key = "spark" if "spark" in m.lower() else "lfm3"
            url = self.endpoints.get(m_key, self.base_url)
            if self.check_health(url):
                status[m_key] = True
                continue

            # Boot the missing server
            if m_key == "spark":
                cmd = [
                    "llama-server",
                    "-m", "models/Spark-X2.6-4B-Q4_K_M.gguf",
                    "--port", "8080",
                    "--ctx-size", "65536",
                    "--parallel", "8",
                    "-ngl", "99"
                ]
            else:
                cmd = [
                    "llama-server",
                    "-hf", "LiquidAI/LFM3-1.7B-GGUF:Q4_K_M",
                    "--port", "8081",
                    "--ctx-size", "32768",
                    "--parallel", "16",
                    "-ngl", "99"
                ]

            try:
                subprocess.Popen(
                    cmd,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True
                )
                # Wait for health
                for _ in range(12):
                    time.sleep(0.5)
                    if self.check_health(url):
                        status[m_key] = True
                        break
                else:
                    status[m_key] = False
            except Exception:
                status[m_key] = False

        return status

    def get_active_url(
        self,
        target_model: Optional[str] = None,
        task_intent: str = "code",
        context_needed: int = 2048,
        is_micro_patch: bool = False,
        prompt: str = ""
    ) -> Tuple[str, str]:
        """
        Resolves active server URL and model ID based on AutoModelPolicy.
        Returns: (base_url, model_id)
        """
        if target_model:
            m_key = "spark" if "spark" in target_model.lower() else "lfm3"
            return self.endpoints.get(m_key, self.base_url), m_key

        plan = self.model_policy.resolve(
            mode=self.model_mode,
            task_intent=task_intent,
            context_needed=context_needed,
            is_micro_patch=is_micro_patch,
            prompt=prompt
        )
        url = self.endpoints.get(plan["id"], self.base_url)
        # If resolved endpoint is down but base_url is alive, fallback gracefully
        if not self.check_health(url) and self.check_health(self.base_url):
            return self.base_url, self.model_family

        return url, plan["id"]

    def chat(
        self,
        messages: List[Dict[str, str]],
        temperature: float = 0.0,
        max_tokens: int = 600,
        response_format: Optional[Dict[str, Any]] = None,
        grammar: Optional[str] = None,
        task_intent: str = "code",
        is_retry: bool = False,
        enable_thinking: Optional[bool] = None,
        target_model: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Sends chat completion request to the auto-selected or specified model server.
        Supports native thinking resolution and chat_template_kwargs toggling.
        """
        last_prompt = messages[-1].get("content", "") if messages else ""
        if enable_thinking is None:
            enable_thinking = self.policy.resolve(
                mode=self.thinking_mode,
                task_intent=task_intent,
                has_schema=bool(response_format),
                is_retry=is_retry,
                prompt=last_prompt
            )

        active_url, resolved_model = self.get_active_url(
            target_model=target_model,
            task_intent=task_intent,
            context_needed=max_tokens * 2,
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
            f"{active_url}/v1/chat/completions",
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
                    "model_used": resolved_model,
                    "active_url": active_url,
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
                "model_used": resolved_model,
                "active_url": active_url,
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
        stop: Optional[List[str]] = None,
        task_intent: str = "code",
        target_model: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Direct native completion endpoint with prefix pre-filling support.
        Automatically routes micro-patching to LFM3 (sub-second) and complex reasoning to Spark.
        """
        is_micro = (n_predict <= 300 and ("assert" not in prompt.lower()))
        active_url, resolved_model = self.get_active_url(
            target_model=target_model,
            task_intent=task_intent,
            context_needed=n_predict * 2,
            is_micro_patch=is_micro,
            prompt=prompt
        )

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
            f"{active_url}/completion",
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
                    "model_used": resolved_model,
                    "active_url": active_url,
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
                "model_used": resolved_model,
                "active_url": active_url,
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
            if isinstance(parsed, dict):
                import re
                clean_parsed = {}
                for k, v in parsed.items():
                    if isinstance(v, str):
                        # Strip trailing markdown codeblock delimiter or extra JSON characters if accidentally emitted
                        if "'" in v or "`" in v or "\n" in v:
                            v_clean = re.split(r"['\"`\s\(\)\{\}]", v)[0].strip()
                            clean_parsed[k] = v_clean if v_clean else v.strip()
                        else:
                            clean_parsed[k] = v.strip()
                    else:
                        clean_parsed[k] = v
                parsed = clean_parsed
            return {"success": True, "valid_json": True, "parsed": parsed, "raw": content, "elapsed_sec": res["elapsed_sec"]}
        except Exception as e:
            return {"success": False, "valid_json": False, "parsed": None, "raw": content, "error": str(e), "elapsed_sec": res["elapsed_sec"]}
