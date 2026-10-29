"""
Improvement 4: Closed-Loop Execution Feedback & Self-Healing Harness.
Executes candidate code in an ultra-fast sandbox check.
If syntax errors or assertion failures occur, pipes the exact traceback back for 1-turn targeted self-healing.
"""

import sys
import subprocess
import tempfile
import time
from typing import Dict, Any, Tuple
from ollama_client import OllamaClient
from context_compressor import compress_agent_payload

def execute_preflight_check(code: str, test_code: str = "") -> Tuple[bool, str]:
    """
    Runs an ultra-fast local sandbox execution check.
    Returns (passed, error_message).
    """
    full_script = f"{code}\n\n{test_code}"
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=True) as tmp:
        tmp.write(full_script)
        tmp.flush()

        try:
            res = subprocess.run(
                [sys.executable, tmp.name],
                capture_output=True,
                text=True,
                timeout=3.0
            )
            if res.returncode == 0:
                return True, ""
            else:
                err = (res.stderr or res.stdout).strip().splitlines()[-3:]
                return False, "\n".join(err)
        except subprocess.TimeoutExpired:
            return False, "Execution timed out (potential infinite loop)"
        except Exception as e:
            return False, str(e)


class SelfHealingHarness:
    def __init__(self, model: str = "lfm3:latest"):
        self.client = OllamaClient(model=model)

    def generate_with_self_healing(self, prompt: str, entry_point: str, smoke_tests: str = "") -> Dict[str, Any]:
        t0 = time.time()
        # Attempt 1: Generate code
        res1 = self.client.chat(
            messages=[
                {"role": "system", "content": "You are an expert Python engineer. Output ONLY valid, executable Python code in ```python ```. Do NOT include docstrings or markdown text."},
                {"role": "user", "content": prompt}
            ],
            think=False,
            max_tokens=800
        )
        code1 = compress_agent_payload(res1["content"] or res1["thinking"])
        if f"def {entry_point}" not in code1:
            code1 = prompt.split('"""')[0].strip() + "\n" + code1

        # Pre-flight sandbox run
        passed, error = execute_preflight_check(code1, smoke_tests)
        if passed or not error:
            return {
                "final_code": code1,
                "repaired": False,
                "total_time_sec": round(time.time() - t0, 2)
            }

        # Attempt 2: Targeted 1-turn closed-loop repair
        repair_prompt = (
            f"Your previous Python code failed with this error:\n"
            f"ERROR:\n{error}\n\n"
            f"Fix the bug and return the complete corrected function in ```python ``` with no conversational text."
        )
        res2 = self.client.chat(
            messages=[
                {"role": "system", "content": "You are a surgical code debugger. Fix the provided code based on the runtime error."},
                {"role": "user", "content": repair_prompt}
            ],
            think=False,
            max_tokens=800
        )
        code2 = compress_agent_payload(res2["content"] or res2["thinking"])
        if f"def {entry_point}" not in code2:
            code2 = prompt.split('"""')[0].strip() + "\n" + code2

        return {
            "final_code": code2,
            "repaired": True,
            "original_error": error,
            "total_time_sec": round(time.time() - t0, 2)
        }
