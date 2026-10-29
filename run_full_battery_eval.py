"""
Comprehensive Full Test Battery for LFM3 1.7B Swarm Framework.
Backend: llama.cpp (Metal acceleration via llama-server on port 8080)
Default Thinking Policy: "auto"

Test Battery Suites:
1. Suite A: Auto-Thinking Policy & Decision Logic Verification
2. Suite B: Real-World Production Codebase Benchmark (psf/requests - 15,000 LOC, 4 Tasks)
3. Suite C: Multi-Repo SWE-Bench Lite Evaluation (Django, Pytest, Requests, Astropy)
4. Telemetry Compilation & Comprehensive Scorecard
"""

import os
import sys
import json
import time
import ast
import re
from typing import Dict, Any, List

from llama_cpp_client import LlamaCppClient, AutoThinkingPolicy, AutoContextPolicy
from repo_indexer import RepoASTIndexer
from run_requests_repo_benchmark import TASKS, REPO_DIR, reset_repo
from run_llama_cpp_repo_benchmark import LlamaCppBenchmarkRunner
from run_swe_bench_mini import SWE_BENCH_INSTANCES

def run_suite_a_policy_verification(client: LlamaCppClient) -> Dict[str, Any]:
    print("\n" + "=" * 76)
    print(" SUITE A1: AUTO-THINKING POLICY & DECISION ENGINE VERIFICATION")
    print("=" * 76)

    cases = [
        {"intent": "synthesis", "has_schema": False, "is_retry": False, "prompt": "def add(a, b): return a + b", "expected": False, "desc": "Direct Code Synthesis"},
        {"intent": "completion", "has_schema": False, "is_retry": False, "prompt": "url = parse_url(x)", "expected": False, "desc": "Prefix Code Completion"},
        {"intent": "schema", "has_schema": True, "is_retry": False, "prompt": "Output JSON", "expected": False, "desc": "GBNF / JSON Schema Decoding"},
        {"intent": "diagnosis", "has_schema": False, "is_retry": False, "prompt": "Analyze root cause of memory leak", "expected": True, "desc": "Root-Cause Diagnostic Analysis"},
        {"intent": "planning", "has_schema": False, "is_retry": False, "prompt": "Plan multi-step migration", "expected": True, "desc": "High-Level Architecture Planning"},
        {"intent": "synthesis", "has_schema": False, "is_retry": True, "prompt": "AssertionError: assert 1 == 2", "expected": True, "desc": "Execution Retry with AssertionError"}
    ]

    all_passed = True
    results = []
    for c in cases:
        actual = client.policy.resolve(
            mode="auto",
            task_intent=c["intent"],
            has_schema=c["has_schema"],
            is_retry=c["is_retry"],
            prompt=c["prompt"]
        )
        passed = (actual == c["expected"])
        if not passed:
            all_passed = False
        print(f" -> [{ 'PASS' if passed else 'FAIL' }] {c['desc']:<38} | Resolved: {str(actual):<5} | Expected: {c['expected']}")
        results.append({
            "test_case": c["desc"],
            "resolved": actual,
            "expected": c["expected"],
            "passed": passed
        })

    return {
        "suite": "Suite A1: Auto-Thinking Policy",
        "passed": all_passed,
        "total_tests": len(cases),
        "passed_tests": sum(1 for r in results if r["passed"]),
        "details": results
    }

def run_suite_a2_context_verification(client: LlamaCppClient) -> Dict[str, Any]:
    print("\n" + "=" * 76)
    print(" SUITE A2: AUTO-CONTEXT POLICY & DYNAMIC SCALING VERIFICATION")
    print("=" * 76)

    cases = [
        {"prompt": "def add(a, b): return a + b", "intent": "code", "files": 1, "expected_ctx": 2048, "desc": "Tier 1: Micro Patch (<1.5k tok)"},
        {"prompt": "x" * 8000, "intent": "code", "files": 1, "expected_ctx": 8192, "desc": "Tier 2: Module Context (1.5k-6k tok)"},
        {"prompt": "x" * 30000, "intent": "call_graph", "files": 3, "expected_ctx": 32768, "desc": "Tier 3: Multi-File Call Graph"},
        {"prompt": "x" * 120000, "intent": "architecture", "files": 8, "expected_ctx": 65536, "desc": "Tier 4: Subsystem Integration"},
        {"prompt": "x" * 250000, "intent": "audit", "files": 25, "expected_ctx": 131072, "desc": "Tier 5: Deep Codebase"},
        {"prompt": "x" * 1200000, "intent": "repo_wide", "files": 60, "expected_ctx": 262144, "desc": "Tier 6: Full Monorepo (256k)"},
        {"prompt": "override", "intent": "code", "files": 1, "override": "64k", "expected_ctx": 64000, "desc": "Manual Override (64k)"}
    ]

    all_passed = True
    results = []
    for c in cases:
        override = c.get("override", "auto")
        plan = client.context_policy.resolve(
            mode=override,
            prompt=c["prompt"],
            task_intent=c["intent"],
            file_count=c["files"]
        )
        passed = (plan["ctx_size"] == c["expected_ctx"])
        if not passed:
            all_passed = False
        print(f" -> [{ 'PASS' if passed else 'FAIL' }] {c['desc']:<38} | Resolved: {plan['ctx_size']} tok ({plan['tier']})")
        results.append({
            "test_case": c["desc"],
            "resolved_ctx": plan["ctx_size"],
            "expected_ctx": c["expected_ctx"],
            "tier": plan["tier"],
            "passed": passed
        })

    return {
        "suite": "Suite A2: Auto-Context Policy",
        "passed": all_passed,
        "total_tests": len(cases),
        "passed_tests": sum(1 for r in results if r["passed"]),
        "details": results
    }

def run_suite_b_production_repo(runner: LlamaCppBenchmarkRunner) -> Dict[str, Any]:
    print("\n" + "=" * 76)
    print(" SUITE B: REAL-WORLD PRODUCTION REPO BENCHMARK (psf/requests - 15k LOC)")
    print("=" * 76)

    t0 = time.time()
    results = []
    for task in TASKS:
        res = runner.run_benchmark_task(task)
        results.append(res)
        print(f"Task {res['task_id']} ({res['title']}): Passed={res['passed']} in {res['latency']}s (Scout={res['scout_match']})")

    total_latency = time.time() - t0
    pass_count = sum(1 for r in results if r["passed"])
    return {
        "suite": "Suite B: psf/requests (15k LOC)",
        "passed": (pass_count == len(TASKS)),
        "pass_count": pass_count,
        "total_tasks": len(TASKS),
        "total_latency": round(total_latency, 2),
        "results": results
    }

def run_suite_c_swe_bench_mini(client: LlamaCppClient) -> Dict[str, Any]:
    import textwrap
    print("\n" + "=" * 76)
    print(" SUITE C: MULTI-REPO SWE-BENCH LITE EVALUATION (5 Top OSS Repos)")
    print("=" * 76)

    results = []
    t0 = time.time()

    for inst in SWE_BENCH_INSTANCES:
        t_inst = time.time()
        print(f"\nEvaluating {inst['instance_id']} ({inst['repo']})...")
        lines = [l for l in inst['code_context'].strip().splitlines() if not l.strip().startswith('#')]
        prefill = lines[0].strip() if lines else ""

        sys_prompt = (
            "You are a Principal Software Engineer. Fix the bug in the provided code snippet.\n"
            "CRITICAL RULES:\n"
            "1. Emit ONLY the corrected Python code inside a ```python ``` block.\n"
            "2. DO NOT add any import statements.\n"
            "3. ZERO commentary or conversational text."
        )
        user_prompt = (
            f"[BUG SPECIFICATION]:\n{inst['problem_summary']}\n\n"
            f"[SOURCE CODE WINDOW]:\n```python\n{textwrap.dedent(inst['code_context'].strip())}\n```"
        )
        full_prompt = (
            f"<|im_start|>system\n{sys_prompt}\n<|im_end|>\n"
            f"<|im_start|>user\n{user_prompt}\n<|im_end|>\n"
            f"<|im_start|>assistant\n```python\n{prefill}"
        )

        res = client.completion(
            prompt=full_prompt,
            n_predict=300,
            temperature=0.0,
            stop=["```", "<|im_end|>", "<|endoftext|>"]
        )
        gen_text = prefill + "\n" + res.get("content", "")
        el = time.time() - t_inst
        tok_speed = res.get("tokens_per_sec", 0.0)

        # Verification: check ground truth keyword and in-memory AST syntax
        keyword_present = inst["ground_truth_fix_keyword"] in gen_text
        try:
            ast.parse(textwrap.dedent(gen_text))
            ast_valid = True
        except Exception:
            ast_valid = False

        passed = keyword_present and ast_valid
        print(f" -> Fix Keyword Present: {keyword_present} ('{inst['ground_truth_fix_keyword']}')")
        print(f" -> AST Syntax Valid: {ast_valid}")
        print(f" -> Passed: {passed} in {el:.2f}s ({res.get('tokens')} tokens @ {tok_speed} tok/s)")

        results.append({
            "instance_id": inst["instance_id"],
            "repo": inst["repo"],
            "passed": passed,
            "keyword_match": keyword_present,
            "ast_valid": ast_valid,
            "latency": round(el, 2),
            "tokens": res.get("tokens"),
            "tokens_per_sec": tok_speed
        })

    total_latency = time.time() - t0
    pass_count = sum(1 for r in results if r["passed"])
    return {
        "suite": "Suite C: SWE-Bench Lite Mini",
        "passed": (pass_count == len(SWE_BENCH_INSTANCES)),
        "pass_count": pass_count,
        "total_tasks": len(SWE_BENCH_INSTANCES),
        "total_latency": round(total_latency, 2),
        "results": results
    }

def run_full_battery():
    print("=" * 80)
    print("   LFM3 1.7B FULL TEST BATTERY: LLAMA.CPP METAL BACKEND & AUTO-THINKING")
    print("=" * 80)
    print(f"Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"Backend Server: http://127.0.0.1:8080 (llama-server Metal GPU, --parallel 4)")
    print(f"Default Thinking Policy: auto")

    client = LlamaCppClient(base_url="http://127.0.0.1:8080", thinking_mode="auto")
    assert client.check_health(), "llama-server on port 8080 is not reachable!"
    runner = LlamaCppBenchmarkRunner(base_url="http://127.0.0.1:8080", thinking_mode="auto")

    t_global_start = time.time()

    # Run Suite A1
    suite_a1 = run_suite_a_policy_verification(client)

    # Run Suite A2
    suite_a2 = run_suite_a2_context_verification(client)

    # Run Suite B
    suite_b = run_suite_b_production_repo(runner)

    # Run Suite C
    suite_c = run_suite_c_swe_bench_mini(client)

    total_battery_time = time.time() - t_global_start

    # Compile Final Battery Summary
    print("\n" + "=" * 80)
    print("                      FULL TEST BATTERY SUMMARY SCORECARD")
    print("=" * 80)
    print(f"{'Battery Suite':<40} | {'Status':<10} | {'Score':<10} | {'Time':<8}")
    print("-" * 76)
    print(f"{suite_a1['suite']:<40} | {'PASS' if suite_a1['passed'] else 'FAIL':<10} | {suite_a1['passed_tests']}/{suite_a1['total_tests']:<8} | {'<0.1s':<8}")
    print(f"{suite_a2['suite']:<40} | {'PASS' if suite_a2['passed'] else 'FAIL':<10} | {suite_a2['passed_tests']}/{suite_a2['total_tests']:<8} | {'<0.1s':<8}")
    print(f"{suite_b['suite']:<40} | {'PASS' if suite_b['passed'] else 'FAIL':<10} | {suite_b['pass_count']}/{suite_b['total_tasks']:<8} | {str(suite_b['total_latency'])+'s':<8}")
    print(f"{suite_c['suite']:<40} | {'PASS' if suite_c['passed'] else 'FAIL':<10} | {suite_c['pass_count']}/{suite_c['total_tasks']:<8} | {str(suite_c['total_latency'])+'s':<8}")
    print("-" * 76)
    total_passed = suite_a1["passed_tests"] + suite_a2["passed_tests"] + suite_b["pass_count"] + suite_c["pass_count"]
    total_count = suite_a1["total_tests"] + suite_a2["total_tests"] + suite_b["total_tasks"] + suite_c["total_tasks"]
    overall_pct = (total_passed / total_count) * 100
    print(f"{'OVERALL BATTERY COMPOSITE':<40} | {'PASS' if overall_pct == 100 else 'PARTIAL':<10} | {total_passed}/{total_count} ({overall_pct:.1f}%) | {total_battery_time:.2f}s")
    print("=" * 80)

    # Save structured results
    summary_data = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "backend": "llama.cpp (Metal)",
        "thinking_mode": "auto",
        "context_mode": "auto",
        "total_time_sec": round(total_battery_time, 2),
        "overall_pass_rate_pct": round(overall_pct, 1),
        "suite_a1_thinking_policy": suite_a1,
        "suite_a2_context_policy": suite_a2,
        "suite_b_requests_repo": suite_b,
        "suite_c_swe_bench_mini": suite_c
    }

    with open("results/full_battery_eval_report.json", "w") as fp:
        json.dump(summary_data, fp, indent=2)
    print("\nSaved full battery structured data to results/full_battery_eval_report.json")

    return summary_data

if __name__ == "__main__":
    run_full_battery()
