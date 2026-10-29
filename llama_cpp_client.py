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
from typing import Dict, Any, List, Optional

socket.setdefaulttimeout(40.0)

class LlamaCppClient:
    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8080",
        model: str = "LiquidAI/LFM3-1.7B-GGUF:Q4_K_M",
        timeout: float = 35.0
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout

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
        grammar: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Sends chat completion request to llama-server.
        """
        payload: Dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False
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
