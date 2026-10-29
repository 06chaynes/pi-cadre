"""
Test Suite 3 (Refined): Common Coding Assistant Tasks for LFM3 1.7B Swarm.
Uses appropriate token bounds and prompt formatting for code generation tasks.
"""

import os
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from ollama_client import OllamaClient

CODING_BENCHMARK_TASKS = [
    {
        "id": "code-bug-fix",
        "task": "Bug Localization and Fix",
        "system": "You are a software engineer. Fix bugs concisely and return the corrected python code.",
        "prompt": """Fix the off-by-one bug in binary_search. Return the corrected code:
def binary_search(arr, target):
    low = 0
    high = len(arr)
    while low <= high:
        mid = (low + high) // 2
        if arr[mid] == target:
            return mid
        elif arr[mid] < target:
            low = mid + 1
        else:
            high = mid
    return -1""",
        "max_tokens": 400
    },
    {
        "id": "code-unit-tests",
        "task": "Test Suite Generation",
        "system": "You are a QA automation engineer specializing in pytest. Write concise unit tests.",
        "prompt": """Write 3 concise pytest unit tests for a TokenBucket rate limiter with parameters (capacity=10, fill_rate=2.0). Cover:
1. Normal token consumption
2. Throttling when depleted
3. Bucket refill after elapsed time
Keep implementations minimal and concise.""",
        "max_tokens": 500
    },
    {
        "id": "code-refactoring",
        "task": "Algorithmic Refactoring & Complexity Reduction",
        "system": "You are a performance optimization expert. Refactor code to lower time complexity.",
        "prompt": """Refactor this O(N^2) duplicate finder into optimal O(N) time complexity using a set:
def find_duplicates(items):
    dups = []
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            if items[i] == items[j] and items[i] not in dups:
                dups.append(items[i])
    return dups""",
        "max_tokens": 400
    },
    {
        "id": "code-type-docs",
        "task": "Docstring & Strict Type Annotations",
        "system": "You are a Python typing expert. Add Google-style docstrings and PEP 484 type hints.",
        "prompt": """Add strict type hints and a Google-style docstring to this function:
def calculate_portfolio_weights(holdings, prices):
    total = sum(holdings[k] * prices[k] for k in holdings)
    return {k: (holdings[k] * prices[k]) / total for k in holdings}""",
        "max_tokens": 450
    }
]

def run_coding_swarm_test(concurrency: int = 4) -> Dict[str, Any]:
    print(f"\n--- Running Test 3: Common Coding Assistant Tasks Swarm ({concurrency} Parallel Coding Specialists) ---")
    client = OllamaClient(model="lfm3:latest")

    t0 = time.time()
    results = []

    def execute_coding_task(task_def: Dict[str, Any]) -> Dict[str, Any]:
        messages = [
            {"role": "system", "content": task_def["system"]},
            {"role": "user", "content": task_def["prompt"]}
        ]
        res = client.chat(messages, think=False, temperature=0.1, max_tokens=task_def.get("max_tokens"))
        res["task_id"] = task_def["id"]
        res["task_name"] = task_def["task"]
        return res

    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        futs = {executor.submit(execute_coding_task, t): t["id"] for t in CODING_BENCHMARK_TASKS}
        for fut in as_completed(futs):
            res = fut.result()
            results.append(res)
            print(f" -> [{res['task_id']} - {res['task_name']}] Finished in {res['elapsed_sec']}s ({res['eval_count']} tokens @ {res['tokens_per_sec']} tok/s)")

    results.sort(key=lambda x: x["task_id"])

    # Multi-Agent Peer Code Review Step
    print("\n[Step 3b] Executing Multi-Agent Peer Code Review on the Generated Bug Fix...")
    fix_output = next((r["content"] or r["thinking"] for r in results if r["task_id"] == "code-bug-fix"), "")

    review_prompt = f"""Review the following proposed bug fix for binary search:

{fix_output}

Provide a 2-bullet review:
1. Correctness validation (did it fix both high = len(arr) - 1 and high = mid - 1?)
2. Code safety & style note."""

    reviewer_messages = [
        {"role": "system", "content": "You are a Principal Software Engineer performing strict code reviews."},
        {"role": "user", "content": review_prompt}
    ]
    review_res = client.chat(reviewer_messages, think=False, temperature=0.1, max_tokens=300)
    print(f" -> [Peer Code Reviewer] Finished in {review_res['elapsed_sec']}s ({review_res['eval_count']} tokens)")

    total_time = round(time.time() - t0, 2)
    total_tokens = sum(r.get("eval_count", 0) for r in results) + review_res.get("eval_count", 0)

    print(f"\nCoding Assistant Swarm completed in {total_time}s ({total_tokens} tokens total).")

    return {
        "test_name": "Common Coding Assistant Swarm",
        "total_time_sec": total_time,
        "total_tokens": total_tokens,
        "tasks": results,
        "peer_review": review_res
    }

if __name__ == "__main__":
    out = run_coding_swarm_test()
    os.makedirs("./results", exist_ok=True)
    with open("./results/coding_swarm_report.json", "w") as f:
        json.dump(out, f, indent=2)
