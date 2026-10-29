"""
Lightweight Ollama Client for Swarm Agents.
Provides async and sync chat calls with error handling, latency & token metrics,
and configurable thinking / temperature parameters.
"""

import urllib.request
import urllib.error
import json
import time
import socket
from typing import Dict, Any, List, Optional

# Enforce global socket timeout to prevent indefinite hangs on sleep/suspend
socket.setdefaulttimeout(35.0)

class OllamaClient:
    def __init__(self, base_url: str = "http://127.0.0.1:11434", model: str = "lfm3:latest", timeout: float = 45.0):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout

    def check_health(self) -> bool:
        try:
            req = urllib.request.Request(f"{self.base_url}/api/tags")
            with urllib.request.urlopen(req, timeout=5.0) as resp:
                data = json.loads(resp.read().decode())
                models = [m.get("name") for m in data.get("models", [])]
                return any(self.model in m for m in models)
        except Exception:
            return False

    def chat(
        self,
        messages: List[Dict[str, str]],
        think: bool = False,
        temperature: float = 0.2,
        max_tokens: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        Sends a chat request to Ollama and collects generation statistics.
        """
        payload: Dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            "think": think,
            "options": {
                "temperature": temperature
            }
        }
        if max_tokens:
            payload["options"]["num_predict"] = max_tokens

        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}/api/chat",
            data=data,
            headers={"Content-Type": "application/json"}
        )

        start_time = time.time()
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw_body = resp.read().decode("utf-8")
                res = json.loads(raw_body)
                elapsed = time.time() - start_time

                message_obj = res.get("message", {})
                content = message_obj.get("content", "").strip()
                thinking = message_obj.get("thinking", "")
                eval_count = res.get("eval_count", 0)
                eval_dur_s = res.get("eval_duration", 0) / 1e9
                tok_per_sec = (eval_count / eval_dur_s) if eval_dur_s > 0 else 0.0

                return {
                    "success": True,
                    "content": content,
                    "thinking": thinking,
                    "elapsed_sec": round(elapsed, 3),
                    "eval_count": eval_count,
                    "prompt_eval_count": res.get("prompt_eval_count", 0),
                    "tokens_per_sec": round(tok_per_sec, 2),
                    "error": None
                }
        except (urllib.error.URLError, socket.timeout, TimeoutError) as e:
            elapsed = time.time() - start_time
            return {
                "success": False,
                "content": "",
                "thinking": "",
                "elapsed_sec": round(elapsed, 3),
                "eval_count": 0,
                "prompt_eval_count": 0,
                "tokens_per_sec": 0.0,
                "error": f"Timeout/URLError: {str(e)}"
            }
        except Exception as e:
            elapsed = time.time() - start_time
            return {
                "success": False,
                "content": "",
                "thinking": "",
                "elapsed_sec": round(elapsed, 3),
                "eval_count": 0,
                "prompt_eval_count": 0,
                "tokens_per_sec": 0.0,
                "error": str(e)
            }
