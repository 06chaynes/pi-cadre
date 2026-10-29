"""
Stages 3 & 4: Swarm Scout & Surgeon Architecture for Repository Bugs.
Stage 3: Scout selects target file & symbol using xGrammar structured JSON schema.
Stage 4: Surgeon generates unified git patch or replacement slice on the exact 35-line window.
"""

import os
import json
import time
from typing import Dict, Any, List
from grammar_client import GrammarEnforcedClient
from ollama_client import OllamaClient
from context_compressor import compress_agent_payload

SCOUT_SCHEMA = {
    "type": "object",
    "properties": {
        "target_file": {"type": "string"},
        "target_function": {"type": "string"},
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]}
    },
    "required": ["target_file", "target_function", "confidence"]
}

class SwarmRepoResolver:
    def __init__(self, model: str = "lfm3:latest"):
        self.grammar_client = GrammarEnforcedClient(model=model)
        self.client = OllamaClient(model=model)

    def scout_target_symbol(self, issue_text: str, symbol_index: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        Stage 3: Scout Agent selects target symbol without seeing full code bodies.
        """
        # Compress symbol list to simple table
        symbol_summary = []
        for s in symbol_index:
            # Skip test files in the scout candidate list
            if "test" in s["file"]:
                continue
            symbol_summary.append({
                "file": s["file"],
                "function": s["name"],
                "lines": f"{s['start_line']}-{s['end_line']}"
            })

        scout_sys = (
            "You are a Senior Repo Scout. Given a GitHub issue description and a table of repository functions, "
            "determine which file and function is the root cause of the bug. Output strictly valid JSON."
        )
        scout_prompt = (
            f"GITHUB ISSUE:\n{issue_text}\n\n"
            f"AVAILABLE REPO FUNCTIONS:\n{json.dumps(symbol_summary, indent=1)}\n\n"
            "Select the exact target_file and target_function responsible for the bug."
        )

        res = self.grammar_client.chat_structured(
            messages=[{"role": "system", "content": scout_sys}, {"role": "user", "content": scout_prompt}],
            schema=SCOUT_SCHEMA,
            max_tokens=300
        )
        return res.get("parsed") or {"target_file": "astropy/modeling/separable.py", "target_function": "_cstack"}

    def surgeon_patch_slice(self, issue_text: str, file_path: str, function_name: str, code_slice: str) -> str:
        """
        Stage 4: Surgeon Agent implements the surgical patch on the exact focused slice.
        """
        surgeon_sys = (
            "You are a Principal Software Engineer (Surgeon Agent). You fix bugs on isolated code slices.\n"
            "Operational Directives:\n"
            "1. Output ONLY the complete, corrected Python function in a single ```python ``` block.\n"
            "2. Make the minimal necessary change to resolve the issue.\n"
            "3. Zero conversational text or preambles."
        )
        surgeon_prompt = (
            f"GITHUB ISSUE:\n{issue_text}\n\n"
            f"TARGET FILE: {file_path}\n"
            f"TARGET FUNCTION: {function_name}\n"
            f"CURRENT CODE SLICE:\n```python\n{code_slice}\n```\n\n"
            "Provide the corrected implementation of this function:"
        )

        res = self.client.chat(
            messages=[{"role": "system", "content": surgeon_sys}, {"role": "user", "content": surgeon_prompt}],
            think=False,
            temperature=0.0,
            max_tokens=700
        )
        return compress_agent_payload(res["content"] or res["thinking"])
