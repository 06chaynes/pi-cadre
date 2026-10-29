"""
Baseline Test: Unguided Repository-Scale Bug Resolution.
Simulates how standard agent setups attempt to solve a multi-file issue:
Giving the agent the raw GitHub issue and the list of repository files, asking it to locate and patch the bug.
"""

import os
import time
import json
from ollama_client import OllamaClient

ISSUE_TEXT = """
Modeling's `separability_matrix` does not compute separability correctly for nested CompoundModels.
Consider the following model:
from astropy.modeling import models as m
from astropy.modeling.separable import separability_matrix

cm = m.Linear1D(10) & m.Linear1D(5)
nested = m.Pix2Sky_TAN() & cm
matrix = separability_matrix(nested)

Suddenly the inputs and outputs are no longer separable?
The bottom-right submatrix should be diagonal True, but returns all True.
"""

REPO_FILES = {
    "astropy/modeling/__init__.py": open("/Users/christian/Documents/lfm-test/mock_repo/astropy/modeling/__init__.py").read(),
    "astropy/modeling/core.py": open("/Users/christian/Documents/lfm-test/mock_repo/astropy/modeling/core.py").read(),
    "astropy/modeling/separable.py": open("/Users/christian/Documents/lfm-test/mock_repo/astropy/modeling/separable.py").read(),
    "test_separable.py": open("/Users/christian/Documents/lfm-test/mock_repo/test_separable.py").read()
}

def run_unguided_baseline_test(model: str = "lfm3:latest") -> dict:
    print("=" * 65)
    print(" BASELINE TEST: UNGUIDED REPOSITORY-SCALE BUG RESOLUTION")
    print(f" Model: {model} | Multi-file Codebase | No AST / No Traceback Slicing")
    print("=" * 65)

    client = OllamaClient(model=model)

    # In unguided setups, the agent is given the repo files and the issue
    prompt = f"GITHUB ISSUE:\n{ISSUE_TEXT}\n\nREPOSITORY FILES:\n"
    for path, content in REPO_FILES.items():
        prompt += f"--- {path} ---\n{content}\n\n"

    prompt += (
        "TASK:\n"
        "1. Identify the file and function containing the bug.\n"
        "2. State the exact line causing the bug.\n"
        "3. Provide the corrected code replacement."
    )

    t0 = time.time()
    res = client.chat(
        [
            {"role": "system", "content": "You are a software engineer fixing a bug across a repository."},
            {"role": "user", "content": prompt}
        ],
        think=False,
        temperature=0.0,
        max_tokens=800
    )

    elapsed = round(time.time() - t0, 2)
    output = res["content"] or res["thinking"]

    # Evaluation criteria:
    # 1. Did it find the right file?
    found_file = "separable.py" in output
    # 2. Did it find the right function?
    found_function = "_cstack" in output
    # 3. Did it find the exact bug? (cright assigning 1 instead of right)
    found_fix = "= right" in output or "cright" in output and "right" in output and "1" in output

    passed = found_file and found_function and found_fix

    print(f"\n[Baseline Result in {elapsed}s]:")
    print(f" - Identified Target File ('separable.py'): {'PASS' if found_file else 'FAIL'}")
    print(f" - Identified Target Function ('_cstack'): {'PASS' if found_function else 'FAIL'}")
    print(f" - Generated Exact Fix ('= right'): {'PASS' if found_fix else 'FAIL'}")
    print(f" -> Overall Baseline Status: {'SUCCESS' if passed else 'FAILURE'}")

    return {
        "benchmark": "Unguided Multi-File Baseline",
        "passed": passed,
        "elapsed_sec": elapsed,
        "found_file": found_file,
        "found_function": found_function,
        "found_fix": found_fix,
        "output": output
    }

if __name__ == "__main__":
    out = run_unguided_baseline_test()
    os.makedirs("./results", exist_ok=True)
    with open("./results/unguided_repo_baseline.json", "w") as f:
        json.dump(out, f, indent=2)
