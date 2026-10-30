"""
Test battery against llama-server. Writes results/full_battery_eval_report.json.

Suites:
  B  psf/requests bug fixes (see repo_benchmark.py)
  C  SWE-bench Lite snippets, scored by fix keyword and AST validity

Usage: python3 run_full_battery_eval.py [--model auto|spark|lfm3]
"""

import argparse
import json
import sys
import textwrap
import time
from pathlib import Path

from benchmark_tasks import REPO_DIR, SWE_BENCH_INSTANCES, TASKS, control_failures
from llama_cpp_client import MODELS, LlamaCppClient, syntax_error
from repo_benchmark import RepoBenchmarkRunner

SWE_PROMPT = (
    "You are a Principal Software Engineer. Fix the bug in the provided code snippet.\n"
    "CRITICAL RULES:\n"
    "1. Emit ONLY the corrected Python code inside a ```python ``` block.\n"
    "2. DO NOT add any import statements.\n"
    "3. ZERO commentary or conversational text."
)


def header(title):
    print(f"\n{'=' * 76}\n {title}\n{'=' * 76}")


def summarize(name, results, t0):
    return {
        "suite": name,
        "passed": sum(r["passed"] for r in results),
        "total": len(results),
        "seconds": round(time.time() - t0, 2),
        "results": results,
    }


def repo_suite(client):
    header("B: psf/requests bug fixes")
    t0 = time.time()
    runner = RepoBenchmarkRunner(client)
    return summarize("B: psf/requests", [runner.run(task) for task in TASKS], t0)


def snippet_window(code_context):
    """Snippet source with comment lines removed and common indentation stripped."""
    lines = [l for l in code_context.splitlines() if not l.strip().startswith("#")]
    return textwrap.dedent("\n".join(lines)).strip("\n")


def swe_suite(client):
    header("C: SWE-bench Lite snippets")
    t0 = time.time()
    model = client.resolve_model("code")
    instruction = "Fix the bug and output strictly the corrected code snippet inside a ```python ``` block."
    results = []
    for inst in SWE_BENCH_INSTANCES:
        snippet = snippet_window(inst["code_context"])
        first = snippet.splitlines()[0].strip()
        prefill = first if first.startswith(("def ", "class ")) else ""
        user = f"[BUG SPECIFICATION]:\n{inst['problem_summary']}\n\n[SOURCE CODE WINDOW]:\n```python\n{snippet}\n```"

        code, res = client.generate_code(model, SWE_PROMPT, user, instruction, prefill, max_tokens=350)
        keyword = inst["ground_truth_fix_keyword"] in code
        parses = syntax_error(snippet_window(code)) is None
        passed = keyword and parses
        print(f" [{'PASS' if passed else 'FAIL'}] {inst['instance_id']:<28} keyword={keyword} parses={parses} "
              f"({res['tokens']} tokens, {res['elapsed_sec']}s)" + (f" syntax repaired {res['repair']}" if res["repaired"] else ""))
        results.append({"instance_id": inst["instance_id"], "passed": passed, "keyword_match": keyword, "ast_valid": parses})
    return summarize("C: SWE-bench Lite", results, t0)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", choices=["auto", *MODELS], default="auto")
    mode = parser.parse_args().model

    online = [m for m in MODELS if LlamaCppClient.check_health(m)]
    if mode not in online and not (mode == "auto" and online):
        sys.exit("No llama-server is reachable for this mode. Start one with launchers/start_llama_server.sh.")
    if not (REPO_DIR / ".git").exists():
        sys.exit(f"Missing {REPO_DIR}. See README.md for the clone command.")
    failures = control_failures(TASKS)
    if failures:
        sys.exit("Task checks do not behave as expected with this interpreter (" + sys.executable + "):\n  "
                 + "\n  ".join(failures) + "\nRun with the Python that has requests_repo's dev requirements installed.")
    print(f"Model mode: {mode}. Online: {', '.join(online)}")

    client = LlamaCppClient(model_mode=mode)
    t0 = time.time()
    suites = [repo_suite(client), swe_suite(client)]

    header("Summary")
    for s in suites:
        print(f" {s['suite']:<32} {s['passed']}/{s['total']:<4} {s['seconds']}s")
    passed, total = sum(s["passed"] for s in suites), sum(s["total"] for s in suites)
    print(f" {'Total':<32} {passed}/{total:<4} {time.time() - t0:.2f}s")

    report = Path("results/full_battery_eval_report.json")
    report.parent.mkdir(exist_ok=True)
    report.write_text(json.dumps({"timestamp": time.strftime("%Y-%m-%d %H:%M:%S"), "model_mode": mode, "suites": suites}, indent=2))
    print(f"\nSaved {report}")


if __name__ == "__main__":
    main()
