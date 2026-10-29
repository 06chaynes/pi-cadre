"""
Improvement 5: Dual-Path Routing (Single-Pass vs. Multi-Pass Decomposition).
Detects complex nested grammars, palindromes, or state-machine problems and decomposes them
into (1) Helper agent and (2) Main Orchestrator agent.
"""

from typing import Dict, Any, Tuple
from self_healing_harness import SelfHealingHarness, execute_preflight_check
from ollama_client import OllamaClient
from context_compressor import compress_agent_payload

class DualPathRouter:
    def __init__(self, model: str = "lfm3:latest"):
        self.client = OllamaClient(model=model)
        self.healer = SelfHealingHarness(model=model)

    def is_complex_task(self, prompt: str) -> bool:
        """Heuristic for state machine / grammar nesting / palindrome complexity"""
        indicators = ["nested", "palindrome", "parse", "grammar", "paren", "group", "stack"]
        return any(ind in prompt.lower() for ind in indicators)

    def solve(self, prompt: str, entry_point: str, smoke_tests: str = "") -> Dict[str, Any]:
        if not self.is_complex_task(prompt):
            # Fast Single-Pass Path with Self-Healing
            return self.healer.generate_with_self_healing(prompt, entry_point, smoke_tests)

        # Complex Path: Subagent Decomposition
        # Step 1: Helper Agent writes pure focused sub-routine
        helper_sys = (
            "You are a subagent that writes modular Python helper utilities.\n"
            "Write a concise, standalone helper function needed to solve this problem (e.g. check palindrome, or find matching bracket).\n"
            "Output ONLY the helper function code in ```python ``` with zero explanation."
        )
        helper_res = self.client.chat(
            [{"role": "system", "content": helper_sys}, {"role": "user", "content": prompt}],
            think=False,
            max_tokens=500
        )
        helper_code = compress_agent_payload(helper_res["content"] or helper_res["thinking"])

        # Step 2: Main Assembler integrates helper
        assembler_sys = (
            "You are the Lead Engineer. Combine the helper function below to implement the complete requested function.\n"
            "Output ONLY the complete runnable python code in ```python ``` with zero markdown text."
        )
        assembler_prompt = f"Helper Function Available:\n{helper_code}\n\nTask:\n{prompt}"
        assembler_res = self.client.chat(
            [{"role": "system", "content": assembler_sys}, {"role": "user", "content": assembler_prompt}],
            think=False,
            max_tokens=900
        )
        full_code = compress_agent_payload(assembler_res["content"] or assembler_res["thinking"])
        if f"def {entry_point}" not in full_code:
            full_code = prompt.split('"""')[0].strip() + "\n" + full_code

        # Run preflight check
        passed, error = execute_preflight_check(full_code, smoke_tests)
        return {
            "final_code": full_code,
            "path": "decomposed_multi_pass",
            "helper_used": helper_code[:100],
            "passed_preflight": passed
        }
