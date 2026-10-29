"""
Foundational Pi-Harness Evaluation Benchmark for LFM3 1.7B.
Runs the complete 20-problem HumanEval benchmark under the tweaked Pi foundational configuration:
1. Native reasoning suppression via reasoning effort configuration
2. Suffix generation anchor: Starts immediately with ```python without preamble
3. Expanded token budget (1200 tokens) to prevent syntax truncation
4. Real Python sandbox execution verification
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

def extract_code(raw_text: str, entry_point: str, prompt: str) -> str:
    matches = re.findall(r"```python\s*(.*?)\s*```", raw_text, re.DOTALL)
    if matches:
        code = matches[-1].strip()
    else:
        code = re.sub(r"```", "", raw_text).strip()

    if f"def {entry_point}" in code:
        idx = code.find(f"def {entry_point}")
        return code[idx:]
    else:
        return prompt + "\n" + code

def run_foundational_benchmark(num_problems: int = 20, max_workers: int = 4) -> Dict[str, Any]:
    print("=" * 65)
    print(f" FOUNDATIONAL PI-HARNESS BENCHMARK: {num_problems} CANONICAL PROBLEMS")
    print(" Architecture: Native Reasoning Suppression + Suffix Code Anchor")
    print("=" * 65)

    all_problems = read_problems()
    task_ids = [f"HumanEval/{i}" for i in range(num_problems)]
    client = OllamaClient(model="lfm3:latest")

    results = []
    t0 = time.time()

    # Foundational system prompt mirroring Pi's updated lfm-coder role
    pi_foundational_system = (
        "You are an expert software engineer. Implement the requested function.\n"
        "Output strictly valid Python code inside a single ```python ``` block. "
        "Start directly with ```python. Zero conversational text before or after."
    )

    def evaluate_task(task_id: str) -> Dict[str, Any]:
        task = all_problems[task_id]
        prompt = task["prompt"]
        entry_point = task["entry_point"]

        res = client.chat(
            messages=[
                {"role": "system", "content": pi_foundational_system},
                {"role": "user", "content": prompt}
            ],
            think=False,
            temperature=0.0,
            max_tokens=1200
        )

        raw = res["content"] or res["thinking"]
        extracted = extract_code(raw, entry_point, prompt)
        check_res = check_correctness(task, extracted, timeout=4.0)

        passed = check_res.get("passed", False)
        error = check_res.get("result", "") if not passed else None

        return {
            "task_id": task_id,
            "entry_point": entry_point,
            "passed": passed,
            "error": error,
            "elapsed_sec": res["elapsed_sec"],
            "eval_count": res["eval_count"]
        }

    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futs = {ex.submit(evaluate_task, tid): tid for tid in task_ids}
        for fut in as_completed(futs):
            r = fut.result()
            results.append(r)
            status_str = "PASS [OK]" if r["passed"] else f"FAIL [{r['error'][:30]}...]"
            print(f" -> {r['task_id']} ({r['entry_point']}): {status_str} in {r['elapsed_sec']}s")

    results.sort(key=lambda x: int(x["task_id"].split("/")[1]))
    passed_count = sum(1 for r in results if r["passed"])
    pct = (passed_count / len(results)) * 100.0
    wall_time = round(time.time() - t0, 2)

    print("\n" + "=" * 65)
    print(f" FINAL SCORE: {passed_count}/{len(results)} PASSED ({pct:.1f}%)")
    print(f" Total Wall Time: {wall_time}s")
    print("=" * 65)

    return {
        "benchmark": "Foundational Pi-Harness Benchmark",
        "num_problems": len(results),
        "passed_count": passed_count,
        "failed_count": len(results) - passed_count,
        "pass_rate_pct": pct,
        "wall_time_sec": wall_time,
        "results": results
    }

if __name__ == "__main__":
    rep = run_foundational_benchmark(num_problems=20)
    os.makedirs("./results", exist_ok=True)
    with open("./results/pi_foundational_benchmark_report.json", "w") as f:
        json.dump(rep, f, indent=2)
