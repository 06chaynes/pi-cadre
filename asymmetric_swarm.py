"""
Improvement 3: Asymmetric Swarm Roles (Drafter vs. Boundary Auditor).
1. Drafter generates initial candidate algorithm.
2. Boundary Auditor specifically checks empty input, single elements, and extreme boundaries.
"""

from typing import Dict, Any, Tuple
from grammar_client import GrammarEnforcedClient
from context_compressor import compress_agent_payload

AUDIT_SCHEMA = {
    "type": "object",
    "properties": {
        "has_boundary_defect": {"type": "boolean"},
        "defect_description": {"type": "string"},
        "repaired_code": {"type": "string"}
    },
    "required": ["has_boundary_defect", "defect_description", "repaired_code"]
}

class AsymmetricSwarm:
    def __init__(self, model: str = "lfm3:latest"):
        self.client = GrammarEnforcedClient(model=model)

    def draft_and_audit(self, prompt: str, entry_point: str) -> Tuple[str, Dict[str, Any]]:
        # Step 1: Drafter generates initial code
        drafter_sys = (
            "You are a fast implementation drafter. Output ONLY executable Python code in a single ```python ``` block. "
            "Do not copy docstrings. Implement the function immediately."
        )
        draft_res = self.client.chat(
            messages=[
                {"role": "system", "content": drafter_sys},
                {"role": "user", "content": prompt}
            ],
            think=False,
            max_tokens=800
        )
        raw_draft = draft_res["content"] or draft_res["thinking"]
        compressed_draft = compress_agent_payload(raw_draft)

        # Step 2: Boundary Auditor checks edge cases with structured JSON
        auditor_sys = (
            "You are a strict Boundary-Case Auditor. Review this code for:\n"
            "1. Empty inputs ([], '', 0)\n"
            "2. Single element inputs\n"
            "3. Off-by-one boundary errors\n"
            "If an issue exists, provide repaired_code. If correct, set has_boundary_defect: false."
        )
        auditor_prompt = f"Function Entry: {entry_point}\nCode:\n{compressed_draft}"

        audit_res = self.client.chat_structured(
            messages=[
                {"role": "system", "content": auditor_sys},
                {"role": "user", "content": auditor_prompt}
            ],
            schema=AUDIT_SCHEMA,
            max_tokens=800
        )

        parsed = audit_res.get("parsed") or {}
        if parsed.get("has_boundary_defect") and parsed.get("repaired_code"):
            final_code = parsed["repaired_code"]
        else:
            final_code = compressed_draft

        return final_code, {"draft_time": draft_res["elapsed_sec"], "audit_res": parsed}
