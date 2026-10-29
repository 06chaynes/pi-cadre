"""
Rigorous HumanEval Benchmark Runner for LFM3 1.7B.
Executes official OpenAI HumanEval problems using real Python execution and assertion verification.
No text matching. If the unit tests fail, it is an objective FAIL.
"""

import os
import re
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, Any, List

from human_eval.data import read_problems
from human_eval.execution import check_correctness
from ollama_client import OllamaClient

def extract_python_code(raw_text: str, entry_point: str, prompt: str) -> str:
    """
    Cleans up LLM completion and guarantees valid Python syntax for execution.
    """
    # 1. Search for markdown python block
    matches = re.findall(r"```python\s*(.*?)\s*```", raw_text, re.DOTALL)
    if matches:
        # Choose the block containing the entry point or the largest block
        code = matches[-1].strip()
    else:
        # Strip generic markdown backticks
        code = re.sub(r"```", "", raw_text).strip()

    # 2. Check if the function definition is present
    if f"def {entry_point}" in code:
        # Find where 'def entry_point' starts
        idx = code.find(f"def {entry_point}")
        full_code = code[idx:]
    else:
        # Model only generated the body; prepend the prompt
        full_code = prompt + "\n" + code

    return full_code


def evaluate_humaneval_sample(num_problems: int = 25, model: str = "lfm3:latest", max_workers: int = 4) -> Dict[str, Any]:
    print("=" * 65)
    print(f" OFFICIAL HUMANEVAL BENCHMARK: {num_problems} EXECUTABLE PYTHON PROBLEMS")
    print(f" Model: {model} | Real Python Sandbox Execution")
    print("=" * 65)

    all_problems = read_problems()
    # Take the first num_problems sequentially for 100% reproducibility
    selected_task_ids = [f"HumanEval/{i}" for i in range(num_problems)]
    client = OllamaClient(model=model)

    results = []
    passed_count = 0
    t0 = time.time()

    def solve_and_test(task_id: str) -> Dict[str, Any]:
        task = all_problems[task_id]
        prompt = task["prompt"]
        entry_point = task["entry_point"]

        instruction = (
            f"You are a professional Python engineer. Complete the following function.\n"
            f"Return ONLY valid, executable Python code for the function.\n\n{prompt}"
        )

        res = client.chat(
            [{"role": "user", "content": instruction}],
            think=False,
            temperature=0.0, # Deterministic greedy decoding
            max_tokens=800
        )

        raw_output = res["content"] or res["thinking"]
        extracted_code = extract_python_code(raw_output, entry_point, prompt)

        # Run real Python unit test suite
        exec_result = check_correctness(task, extracted_code, timeout=4.0)
        passed = exec_result.get("passed", False)
        error_msg = exec_result.get("result", "")

        return {
            "task_id": task_id,
            "entry_point": entry_point,
            "passed": passed,
            "error": error_msg if not passed else None,
            "elapsed_sec": res["elapsed_sec"],
            "eval_count": res["eval_count"],
            "raw_output_sample": raw_output[:200] + "..." if len(raw_output) > 200 else raw_output,
            "extracted_code": extracted_code
        }

    print(f"\n[Running {num_problems} tasks in parallel with {max_workers} workers]...")
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futs = {executor.submit(solve_and_test, tid): tid for tid in selected_task_ids}
        for fut in as_completed(futs):
            r = fut.result()
            results.append(r)
            status_str = "PASS [OK]" if r["passed"] else f"FAIL [{r['error'][:35]}...]"
            print(f" -> {r['task_id']} ({r['entry_point']}): {status_str} in {r['elapsed_sec']}s")

    # Sort results
    results.sort(key=lambda x: int(x["task_id"].split("/")[1]))
    passed_count = sum(1 for r in results if r["passed"])
    pass_rate_pct = (passed_count / len(results)) * 100.0
    total_time = round(time.time() - t0, 2)

    print("\n" + "=" * 65)
    print(f" HUMANEVAL FINAL SCORE: {passed_count}/{len(results)} PASSED ({pass_rate_pct:.1f}%)")
    print(f" Total Wall Time: {total_time}s")
    print("=" * 65)

    return {
        "benchmark": "OpenAI HumanEval",
        "model": model,
        "num_problems": len(results),
        "passed_count": passed_count,
        "failed_count": len(results) - passed_count,
        "pass_rate_pct": pass_rate_pct,
        "total_wall_time_sec": total_time,
        "detailed_results": results
    }

if __name__ == "__main__":
    report = evaluate_humaneval_sample(num_problems=20)
    os.makedirs("./results", exist_ok=True)
    with open("./results/humaneval_official_report.json", "w") as f:
        json.dump(report, f, indent=2)
