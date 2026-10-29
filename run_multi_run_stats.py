"""
Multi-Run Statistical Verification Runner for LFM3 1.7B Tuned Gated Architecture.
Executes N full benchmark passes across the canonical 20-problem HumanEval suite
under real Python sandbox execution to compute mean pass rate, variance, and consistency.
"""

import os
import re
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, Any, List

from human_eval.data import read_problems
from human_eval.execution import check_correctness
from optimized_swarm_router import OptimizedSwarmRouter

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

def run_multi_pass_benchmark(num_runs: int = 3, num_problems: int = 20, max_workers: int = 4) -> Dict[str, Any]:
    print("=" * 70)
    print(f" STATISTICAL VERIFICATION: {num_runs} FULL BENCHMARK RUNS")
    print(f" Suite: HumanEval {num_problems} Problems | Architecture: Tuned Gated Swarm")
    print("=" * 70)

    all_problems = read_problems()
    task_ids = [f"HumanEval/{i}" for i in range(num_problems)]
    router = OptimizedSwarmRouter(model="lfm3:latest")

    run_summaries = []
    problem_pass_matrix = {tid: [] for tid in task_ids}
    total_start = time.time()

    for run_idx in range(1, num_runs + 1):
        print(f"\n--- [RUN {run_idx}/{num_runs}] Commencing full 20-problem benchmark pass ---")
        t_run_start = time.time()
        run_results = []

        def eval_task(tid: str) -> Dict[str, Any]:
            task = all_problems[tid]
            prompt = task["prompt"]
            entry_point = task["entry_point"]

            solve_res = router.solve_task(prompt=prompt, entry_point=entry_point)
            code = solve_res.get("code", "")
            extracted = extract_code(code, entry_point, prompt)

            check_res = check_correctness(task, extracted, timeout=4.0)
            passed = check_res.get("passed", False)
            return {
                "task_id": tid,
                "passed": passed,
                "path": solve_res.get("path")
            }

        with ThreadPoolExecutor(max_workers=max_workers) as ex:
            futs = {ex.submit(eval_task, tid): tid for tid in task_ids}
            for fut in as_completed(futs):
                run_results.append(fut.result())

        run_results.sort(key=lambda x: int(x["task_id"].split("/")[1]))
        passed_in_run = sum(1 for r in run_results if r["passed"])
        pass_pct = (passed_in_run / num_problems) * 100.0
        elapsed_run = round(time.time() - t_run_start, 2)

        for r in run_results:
            problem_pass_matrix[r["task_id"]].append(r["passed"])

        run_summaries.append({
            "run_index": run_idx,
            "passed_count": passed_in_run,
            "total_problems": num_problems,
            "pass_rate_pct": pass_pct,
            "wall_time_sec": elapsed_run
        })

        print(f" -> [Run {run_idx} Finished] {passed_in_run}/{num_problems} Passed ({pass_pct:.1f}%) in {elapsed_run}s")

    # Aggregate stats
    avg_pass_rate = sum(r["pass_rate_pct"] for r in run_summaries) / num_runs
    avg_wall_time = sum(r["wall_time_sec"] for r in run_summaries) / num_runs
    total_wall_time = round(time.time() - total_start, 2)

    # Compute problem consistency
    perfect_tasks = [tid for tid, results in problem_pass_matrix.items() if all(results)]
    flaky_tasks = [tid for tid, results in problem_pass_matrix.items() if any(results) and not all(results)]
    failing_tasks = [tid for tid, results in problem_pass_matrix.items() if not any(results)]

    print("\n" + "=" * 70)
    print(f" MULTI-RUN STATISTICAL AGGREGATION ({num_runs} Runs)")
    print(f" Mean Pass Rate: {avg_pass_rate:.1f}%")
    print(f" Mean Run Wall Time: {avg_wall_time:.1f}s")
    print(f" Consistently Passing Tasks (100% across all runs): {len(perfect_tasks)}/{num_problems}")
    print(f" Flaky Tasks (passed in some runs): {len(flaky_tasks)}/{num_problems}")
    print(f" Consistently Failing Tasks (0% across all runs): {len(failing_tasks)}/{num_problems}")
    print("=" * 70)

    final_payload = {
        "num_runs": num_runs,
        "num_problems": num_problems,
        "mean_pass_rate_pct": round(avg_pass_rate, 2),
        "mean_wall_time_sec": round(avg_wall_time, 2),
        "total_experiment_wall_time_sec": total_wall_time,
        "individual_runs": run_summaries,
        "perfect_tasks": perfect_tasks,
        "flaky_tasks": flaky_tasks,
        "consistently_failing_tasks": failing_tasks,
        "problem_pass_matrix": problem_pass_matrix
    }

    os.makedirs("./results", exist_ok=True)
    with open("./results/multi_run_statistical_report.json", "w") as f:
        json.dump(final_payload, f, indent=2)

    return final_payload

if __name__ == "__main__":
    run_multi_pass_benchmark(num_runs=3, num_problems=20)
