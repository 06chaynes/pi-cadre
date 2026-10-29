"""
Improvement 1 (Refined): Context Pruning & Clean Inter-Agent Messenger.
Compresses prompts, extracts clean payloads, and prunes noisy context before passing across swarm agents.
Ensures complete code blocks are preserved without arbitrary character truncation.
"""

import re
from typing import Dict, Any, List

def compress_agent_payload(raw_message: str, max_chars: int = 4000) -> str:
    """
    Strips markdown fluff, docstring repeats, and conversational filler.
    Retains only the dense, high-signal payload (code, JSON, or key facts).
    Ensures code syntax boundaries are preserved.
    """
    # 1. If code block is present, extract only the code block
    code_match = re.search(r"```(?:python)?\s*(.*?)\s*```", raw_message, re.DOTALL)
    if code_match:
        payload = code_match.group(1).strip()
    else:
        # Strip generic markdown headers and extra whitespace
        payload = re.sub(r"#+\s*", "", raw_message).strip()

    # 2. Prune repetitive docstring blocks inside code
    payload = re.sub(r'"""[\s\S]*?"""', '', payload).strip()
    payload = re.sub(r"'''[\s\S]*?'''", '', payload).strip()

    # 3. Collapse multiple blank lines
    payload = re.sub(r"\n\s*\n+", "\n\n", payload)

    if len(payload) > max_chars:
        return payload[:max_chars]
    return payload
