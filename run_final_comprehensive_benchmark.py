"""
Comprehensive 20-Problem HumanEval Benchmark across the 5 Foundational Improvements.
Executes the full canonical 20-problem suite with:
- Context compression
- xGrammar JSON/code enforcement
- Asymmetric boundary auditing
- Closed-loop execution feedback & self-healing
- Dual-path decomposition
"""

import os
import re
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, Any, List

from human_eval.data import read_problems
from human_eval.execution import check_correctness
from dual_path_router import DualPathRouter
from context_compressor import compress_agent_payload

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
        return prompt.split('"""')[0].strip() + "\n" + code

def run_comprehensive_evaluation(num_problems: int = 20, max_workers: int = 4) -> Dict[str, Any]:
    print("=" * 70)
    print(f" FULL 20-PROBLEM BENCHMARK WITH ALL 5 FOUNDATIONAL IMPROVEMENTS")
    print(" Model: lfm3:latest (1.7B) | Real Python Sandbox Execution")
    print("=" * 70)

    all_problems = read_problems()
    task_ids = [f"HumanEval/{i}" for i in range(num_problems)]
    router = DualPathRouter(model="lfm3:latest")

    results = []
    t0 = time.time()

    def evaluate_task(task_id: str) -> Dict[str, Any]:
        task = all_problems[task_id]
        prompt = task["prompt"]
        entry_point = task["entry_point"]

        # Run through the enhanced dual-path + self-healing router
        solve_res = router.solve(prompt=prompt, entry_point=entry_point)
        candidate_code = solve_res.get("final_code", "")
        extracted = extract_code(candidate_code, entry_point, prompt)

        # Execute official hidden test assertions
        check_res = check_correctness(task, extracted, timeout=4.0)
        passed = check_res.get("passed", False)
        error = check_res.get("result", "") if not passed else None

        return {
            "task_id": task_id,
            "entry_point": entry_point,
            "passed": passed,
            "error": error,
            "path": solve_res.get("path", "single_pass_healed"),
            "repaired": solve_res.get("repaired", False),
            "code_sample": extracted[:150] + "..."
        }

    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futs = {ex.submit(evaluate_task, tid): tid for tid in task_ids}
        for fut in as_completed(futs):
            r = fut.result()
            results.append(r)
            status_str = "PASS [OK]" if r["passed"] else f"FAIL [{r['error'][:30]}...]"
            print(f" -> {r['task_id']} ({r['entry_point']}): {status_str} via {r['path']}")

    results.sort(key=lambda x: int(x["task_id"].split("/")[1]))
    passed_count = sum(1 for r in results if r["passed"])
    pct = (passed_count / len(results)) * 100.0
    wall_time = round(time.time() - t0, 2)

    print("\n" + "=" * 70)
    print(f" FINAL BENCHMARK SCORE: {passed_count}/{len(results)} PASSED ({pct:.1f}%)")
    print(f" Total Wall Time: {wall_time}s")
    print("=" * 70)

    report_data = {
        "benchmark": "HumanEval 20-Problem Canonical Suite",
        "model": "lfm3:latest (1.7B)",
        "num_problems": len(results),
        "passed_count": passed_count,
        "failed_count": len(results) - passed_count,
        "pass_rate_pct": pct,
        "total_wall_time_sec": wall_time,
        "problem_results": results
    }

    with open("./results/final_comprehensive_benchmark_report.json", "w") as f:
        json.dump(report_data, f, indent=2)

    return report_data

if __name__ == "__main__":
    os.makedirs("./results", exist_ok=True)
    run_comprehensive_evaluation()
