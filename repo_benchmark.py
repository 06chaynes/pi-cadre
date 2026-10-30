"""
Bug-fix benchmark on psf/requests. Per task: inject the defect, ask the model to locate it among AST-ranked
candidates, generate a fix for the known target function, gate it on module parsing, run the task's tests, and
retry once with the failure output.
"""

import ast
import json
import re
import time

from benchmark_tasks import REPO_DIR, inject_defect, reset_repo, scout_schema, verify
from llama_cpp_client import AutoThinkingPolicy, LlamaCppClient
from repo_indexer import RepoASTIndexer, words

SCOUT_PROMPT = "You are a Senior Repo Scout. Pinpoint the root-cause file and function. Output strictly valid JSON."
SURGEON_PROMPT = (
    "You are a Principal Software Engineer repairing a bug in requests.\n"
    "CRITICAL RULES:\n"
    "1. Emit ONLY the corrected Python code inside a ```python ``` block.\n"
    "2. DO NOT add any import statements.\n"
    "3. ZERO commentary, explanations, or conversational markdown."
)


def strip_inner_imports(code: str) -> str:
    """Removes import statements from the body of a single generated function."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return code
    if len(tree.body) != 1 or not isinstance(tree.body[0], (ast.FunctionDef, ast.AsyncFunctionDef)):
        return code
    fn = tree.body[0]
    body = [s for s in fn.body if not isinstance(s, (ast.Import, ast.ImportFrom))]
    if len(body) == len(fn.body):
        return code
    fn.body = body
    return ast.unparse(tree)


def reindent(code: str, base_indent: int) -> str:
    """Shifts code so its first statement sits at base_indent, keeping relative indentation. Comments move to base_indent."""
    lines = code.splitlines()
    first = next((l for l in lines if l.strip() and not l.strip().startswith("#")), lines[0] if lines else "")
    shift = base_indent - (len(first) - len(first.lstrip()))
    out = []
    for line in lines:
        text = line.strip()
        if not text:
            out.append("\n")
        elif text.startswith("#"):
            out.append(" " * base_indent + text + "\n")
        else:
            out.append(" " * max(0, len(line) - len(line.lstrip()) + shift) + text + "\n")
    return "".join(out)


class RepoBenchmarkRunner:
    def __init__(self, client: LlamaCppClient):
        self.client = client
        self.indexer = RepoASTIndexer(REPO_DIR / "requests")

    def _scout(self, task) -> bool:
        """Asks the model to pick the buggy function from the 15 symbols that best match the issue. Returns whether it was right."""
        issue = task["description"]
        query = words(issue)

        def score(s):
            named = re.search(rf"\b{re.escape(s['name'].lower())}\b", issue.lower())
            return len(query & words(f"{s['name']} {s['docstring']}")) + (20 if named else 0)

        symbols = [s for s in self.indexer.scan_symbols() if "test" not in s["file"]]
        candidates = [
            {"file": s["file"], "function": s["name"], "lines": f"{s['start_line']}-{s['end_line']}"}
            for s in sorted(symbols, key=score, reverse=True)[:15]
        ]
        prompt = f"GITHUB ISSUE:\n{issue}\n\nAVAILABLE REPO FUNCTIONS:\n{json.dumps(candidates, indent=1)}\n\nSelect target_file and target_function."
        decision = self.client.chat_json(
            [{"role": "system", "content": SCOUT_PROMPT}, {"role": "user", "content": prompt}],
            scout_schema(candidates), max_tokens=200, task_intent="scout",
        ) or {}
        print(f" -> Scout picked {decision.get('target_file')}::{decision.get('target_function')}")
        return decision.get("target_function") == task["function"]

    @staticmethod
    def _apply(task, original_lines, start, end, base_indent, code):
        """Replaces lines start..end of the defective file with code and runs the task check if the module still parses."""
        module = "".join(original_lines[:start - 1]) + reindent(code, base_indent) + "".join(original_lines[end:])
        try:
            ast.parse(module)
        except SyntaxError as e:
            print(f" -> AST gate rejected patch: {e}")
            return False, f"SyntaxError: {e}"
        (REPO_DIR / task["file"]).write_text(module)
        passed, output = verify(task)
        print(f" -> Patch applied. Tests passed: {passed}")
        return passed, output

    def run(self, task):
        print(f"\n=== {task['id']}: {task['title']} ===")
        reset_repo()
        inject_defect(task)
        t0 = time.time()
        scout_match = self._scout(task)

        rel_path = task["file"].removeprefix("requests/")
        original_lines = (REPO_DIR / task["file"]).read_text().splitlines(True)
        ctx = self.indexer.get_clean_function_context(rel_path, task["function"])
        fn_lines = ctx["end_line"] - ctx["start_line"] + 1
        if fn_lines <= 150:
            window, prefill, base_indent = ctx["clean_code"], ctx["signature"], ctx["base_indent"]
            start, end, scope = ctx["start_line"], ctx["end_line"], "function"
        else:
            window, start, end = self.indexer.get_adaptive_source_slice(rel_path, task["function"], task["description"], 45)
            first = next(l for l in window.splitlines() if l.strip())
            prefill, base_indent, scope = first.strip(), len(first) - len(first.lstrip()), "code snippet"
        print(f" -> Context: lines {start}-{end}, base indent {base_indent}")

        imports = "\n".join(self.indexer.get_module_imports(rel_path))
        user = (
            f"[BOUND MODULE IMPORTS (ALREADY AVAILABLE)]:\n{imports}\n\n"
            f"[BUG SPECIFICATION]:\n{task['description']}\n\n"
            f"[SOURCE CODE WINDOW]:\n```python\n{window}\n```"
        )
        instruction = f"Output strictly the entire corrected {scope} inside a ```python ``` block."
        model = self.client.resolve_model("synthesis")
        max_tokens = 450 if model == "lfm3" else (1500 if fn_lines > 45 else 650)

        think = AutoThinkingPolicy.resolve(self.client.thinking_mode, "synthesis")
        code, res = self.client.generate_code(model, SURGEON_PROMPT, user, instruction, prefill, think, max_tokens)
        code = strip_inner_imports(code)
        print(f" -> {model}: {res['tokens']} tokens at {res['tokens_per_sec']} tok/s (think={think})"
              + (f", syntax repaired {res['repair']}" if res["repaired"] else ""))
        passed, output = self._apply(task, original_lines, start, end, base_indent, code)

        if not passed:
            signals = ("assert", "FAILED", "FAILURES", "==", "E ")
            failure = "\n".join([l for l in output.splitlines() if any(s in l for s in signals)][:8]) or output[:250]
            repair = (
                f"[PREVIOUS CANDIDATE CODE]:\n```python\n{code}\n```\n\n"
                f"[TEST FAILURE TRACEBACK]:\n{failure}\n\n"
                "Fix the bug to resolve this failure. Output ONLY the corrected Python code."
            )
            think = AutoThinkingPolicy.resolve(self.client.thinking_mode, "diagnosis", is_retry=True, prompt=failure)
            print(f" -> Retrying with test output (think={think})")
            code, _ = self.client.generate_code(model, SURGEON_PROMPT, repair, instruction, prefill, think, max_tokens)
            passed, _ = self._apply(task, original_lines, start, end, base_indent, strip_inner_imports(code))

        reset_repo()
        return {
            "task_id": task["id"],
            "title": task["title"],
            "passed": passed,
            "latency": round(time.time() - t0, 2),
            "scout_match": scout_match,
        }
