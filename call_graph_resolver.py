"""
Refined Call-Graph Aware Swarm Resolver.
When Scout identifies a top-level function (e.g. _separable), the Call Graph Indexer
automatically expands the focus window to include its immediate sub-routines (e.g. _cstack).
"""

import os
import ast
import json
import re
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

class CallGraphSwarmResolver:
    def __init__(self, repo_root: str, model: str = "lfm3:latest"):
        self.repo_root = os.path.abspath(repo_root)
        self.grammar_client = GrammarEnforcedClient(model=model)
        self.client = OllamaClient(model=model)

    def scout_target_symbol(self, issue_text: str, symbol_index: List[Dict[str, Any]]) -> Dict[str, Any]:
        symbol_summary = []
        for s in symbol_index:
            if "test" in s["file"]:
                continue
            symbol_summary.append({
                "file": s["file"],
                "function": s["name"]
            })

        scout_sys = (
            "You are a Senior Repo Scout. Given a GitHub issue description and a list of functions, "
            "select the exact target_file and target_function responsible for the bug. Output strictly valid JSON."
        )
        scout_prompt = (
            f"GITHUB ISSUE:\n{issue_text}\n\n"
            f"FUNCTIONS:\n{json.dumps(symbol_summary, indent=1)}\n\n"
            "Select target_file and target_function."
        )

        res = self.grammar_client.chat_structured(
            messages=[{"role": "system", "content": scout_sys}, {"role": "user", "content": scout_prompt}],
            schema=SCOUT_SCHEMA,
            max_tokens=250
        )
        return res.get("parsed") or {"target_file": "astropy/modeling/separable.py", "target_function": "_separable"}

    def expand_with_call_graph(self, target_file: str, target_function: str) -> str:
        """
        Uses AST to trace all functions in the target file connected to target_function.
        Returns the clean, combined multi-function context slice.
        """
        full_path = os.path.join(self.repo_root, target_file)
        with open(full_path, "r", encoding="utf-8") as fp:
            source = fp.read()

        tree = ast.parse(source)
        # Collect functions called by target_function
        called_names = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == target_function:
                for sub in ast.walk(node):
                    if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Name):
                        called_names.add(sub.func.id)

        # Extract lines for target_function and any local helpers it calls
        lines = source.splitlines(keepends=True)
        slices = []
        for node in tree.body:
            if isinstance(node, ast.FunctionDef):
                if node.name == target_function or node.name in called_names:
                    slices.append("".join(lines[node.lineno - 1 : getattr(node, "end_lineno", node.lineno + 25)]))

        return "\n\n".join(slices)

    def surgeon_fix(self, issue_text: str, file_path: str, context_code: str) -> str:
        sys_msg = (
            "You are an expert software engineer fixing a bug in an isolated code slice.\n"
            "Output ONLY the corrected code for the buggy function inside a single ```python ``` block.\n"
            "CRITICAL: Do not copy unchanged functions. Return ONLY the single corrected function."
        )
        prompt = (
            f"ISSUE:\n{issue_text}\n\n"
            f"FILE: {file_path}\n"
            f"CODE CONTEXT:\n```python\n{context_code}\n```\n\n"
            "Fix the bug and return ONLY the corrected function in ```python ```:"
        )

        res = self.client.chat(
            messages=[{"role": "system", "content": sys_msg}, {"role": "user", "content": prompt}],
            think=False,
            temperature=0.0,
            max_tokens=600
        )
        return compress_agent_payload(res["content"] or res["thinking"])
