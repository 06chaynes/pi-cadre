"""
Improvement 2: Strict Grammar-Constrained Decoding / JSON Schema Enforcement.
Uses Ollama's native xGrammar engine to mathematically force valid JSON output schemas.
"""

from typing import Dict, Any, Optional
from ollama_client import OllamaClient
import urllib.request
import json
import time

class GrammarEnforcedClient(OllamaClient):
    def chat_structured(
        self,
        messages: list,
        schema: Optional[Dict[str, Any]] = None,
        max_tokens: int = 800
    ) -> Dict[str, Any]:
        """
        Forces output to conform 100% to the provided JSON Schema via xGrammar.
        """
        payload: Dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            "think": False,
            "format": schema if schema else "json",
            "options": {
                "temperature": 0.0,
                "num_predict": max_tokens
            }
        }
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}/api/chat",
            data=data,
            headers={"Content-Type": "application/json"}
        )

        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                res = json.loads(resp.read().decode("utf-8"))
                elapsed = time.time() - t0
                content = res.get("message", {}).get("content", "").strip()
                try:
                    parsed_json = json.loads(content)
                    valid_json = True
                except Exception:
                    parsed_json = None
                    valid_json = False

                return {
                    "success": True,
                    "valid_json": valid_json,
                    "parsed": parsed_json,
                    "raw": content,
                    "elapsed_sec": round(elapsed, 3),
                    "eval_count": res.get("eval_count", 0)
                }
        except Exception as e:
            return {
                "success": False,
                "valid_json": False,
                "parsed": None,
                "raw": "",
                "error": str(e),
                "elapsed_sec": round(time.time() - t0, 3)
            }
