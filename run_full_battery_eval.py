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

def run_suite_a3_model_policy_verification(client: LlamaCppClient) -> Dict[str, Any]:
    print("\n" + "=" * 76)
    print(" SUITE A3: AUTO-MODEL POLICY & DYNAMIC ROUTING VERIFICATION")
    print("=" * 76)

    cases = [
        {"mode": "auto", "intent": "micro_patch", "ctx": 2048, "expected_model": "lfm3", "desc": "Auto: Micro-Patch (<2k tok) -> LFM3-1.7B"},
        {"mode": "auto", "intent": "scout", "ctx": 2048, "expected_model": "lfm3", "desc": "Auto: High-Throughput Swarm Scout -> LFM3-1.7B"},
        {"mode": "auto", "intent": "architecture", "ctx": 65536, "expected_model": "spark", "desc": "Auto: Architecture Planning -> Spark-X2.6-4B"},
        {"mode": "auto", "intent": "diagnosis", "ctx": 32768, "expected_model": "spark", "desc": "Auto: Diagnostic Self-Healing -> Spark-X2.6-4B"},
        {"mode": "auto", "intent": "repo_wide", "ctx": 524288, "expected_model": "spark", "desc": "Auto: Massive Context (512k) -> Spark-X2.6-4B"},
        {"mode": "spark", "intent": "micro_patch", "ctx": 2048, "expected_model": "spark", "desc": "Override: Global Force Spark -> Spark-X2.6-4B"},
        {"mode": "lfm3", "intent": "architecture", "ctx": 65536, "expected_model": "lfm3", "desc": "Override: Global Force LFM3 -> LFM3-1.7B"}
    ]

    all_passed = True
    results = []
    for c in cases:
        plan = client.model_policy.resolve(
            mode=c["mode"],
            task_intent=c["intent"],
            context_needed=c["ctx"]
        )
        passed = (plan["id"] == c["expected_model"])
        if not passed:
            all_passed = False
        print(f" -> [{ 'PASS' if passed else 'FAIL' }] {c['desc']:<45} | Resolved: {plan['name']}")
        results.append({
            "test_case": c["desc"],
            "resolved_model": plan["id"],
            "expected_model": c["expected_model"],
            "passed": passed
        })

    return {
        "suite": "Suite A3: Auto-Model Policy",
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
        first_line = lines[0].strip() if lines else ""

        sys_prompt = (
            "You are a Principal Software Engineer. Fix the bug in the provided code snippet.\n"
            "CRITICAL RULES:\n"
            "1. Emit ONLY the corrected Python code inside a ```python ``` block.\n"
            "2. DO NOT add any import statements.\n"
            "3. ZERO commentary or conversational text."
        )
        clean_code_context = textwrap.dedent("\n".join(l for l in inst["code_context"].strip().splitlines() if not l.strip().startswith("#")))
        user_prompt = (
            f"[BUG SPECIFICATION]:\n{inst['problem_summary']}\n\n"
            f"[SOURCE CODE WINDOW]:\n```python\n{clean_code_context}\n```"
        )
        
        active_url, resolved_model = client.get_active_url(task_intent="code", prompt=inst["problem_summary"])
        is_spark = ("spark" in resolved_model.lower())

        if is_spark:
            msgs = [
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": user_prompt + "\n\nFix the bug and output strictly the corrected code snippet inside a ```python ``` block."}
            ]
            res = client.chat(msgs, max_tokens=350, temperature=0.0, target_model="spark")
            raw_text = res.get("content", "")
            blocks = re.findall(r"```(?:python)?\s*(.*?)\s*```", raw_text, re.DOTALL)
            gen_text = blocks[0].strip() if blocks else raw_text.strip()
        else:
            # Prefill only structural function/class headers; do not prefill the defect line itself
            if first_line.startswith("def ") or first_line.startswith("class "):
                assistant_header = f"```python\n{first_line}"
                full_prompt = (
                    f"<|im_start|>system\n{sys_prompt}\n<|im_end|>\n"
                    f"<|im_start|>user\n{user_prompt}\n<|im_end|>\n"
                    f"<|im_start|>assistant\n{assistant_header}"
                )
                res = client.completion(
                    prompt=full_prompt,
                    n_predict=350,
                    temperature=0.0,
                    stop=["```", "<|im_end|>", "<|endoftext|>"],
                    task_intent="code",
                    target_model="lfm3"
                )
                gen_text = first_line + "\n" + res.get("content", "")
            else:
                full_prompt = (
                    f"<|im_start|>system\n{sys_prompt}\n<|im_end|>\n"
                    f"<|im_start|>user\n{user_prompt}\n<|im_end|>\n"
                    f"<|im_start|>assistant\n```python\n"
                )
                res = client.completion(
                    prompt=full_prompt,
                    n_predict=350,
                    temperature=0.0,
                    stop=["```", "<|im_end|>", "<|endoftext|>"],
                    task_intent="code",
                    target_model="lfm3"
                )
                gen_text = res.get("content", "")

        el = time.time() - t_inst
        tok_speed = res.get("tokens_per_sec", 0.0)

        # Verification: check ground truth keyword and in-memory AST syntax
        keyword_present = inst["ground_truth_fix_keyword"] in gen_text
        sanitized_gen = re.sub(r':(\s*\n\s*\):)', r'\1', gen_text)
        code_no_comments = "\n".join(l for l in sanitized_gen.splitlines() if not l.strip().startswith("#"))
        dedented = textwrap.dedent(code_no_comments).strip()
        try:
            ast.parse(dedented)
            ast_valid = True
        except SyntaxError:
            try:
                # Wrap inside a function scope in case the snippet contains 'return', 'yield', or method-level statements
                ast.parse(f"def _dummy():\n{textwrap.indent(dedented, '    ')}")
                ast_valid = True
            except Exception as e:
                ast_valid = False
                print(f" -> AST Validation Error: {e}")
        except Exception as e:
            ast_valid = False
            print(f" -> AST Validation Error: {e}")

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

def run_full_battery(model_mode: str = "auto"):
    import argparse
    parser = argparse.ArgumentParser(description="Multi-Model Swarm Full Test Battery")
    parser.add_argument("--model", choices=["auto", "spark", "lfm3"], default="auto", help="Model routing mode")
    args, _ = parser.parse_known_args()
    mode = args.model or model_mode

    print("=" * 80)
    print("      MULTI-MODEL SWARM FULL TEST BATTERY: SPARK-X2.6-4B & LFM3-1.7B")
    print("=" * 80)
    print(f"Timestamp:              {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"Active Model Mode:       {mode.upper()} ({'Dynamic Auto-Routing' if mode == 'auto' else 'Global Override'})")
    print(f"Primary Spark Endpoint:  http://127.0.0.1:8080 (Spark-X2.6-4B, 1M Context)")
    print(f"Primary LFM3 Endpoint:   http://127.0.0.1:8081 (LFM3-1.7B, 256k Context)")
    print(f"Thinking Mode:           auto")
    print(f"Context Mode:            auto")

    client = LlamaCppClient(thinking_mode="auto", context_mode="auto", model_mode=mode)
    
    # Auto-start servers if any are offline
    print("\n[Auto-Start] Verifying server daemon readiness...")
    server_status = client.ensure_servers()
    for s_name, s_ok in server_status.items():
        print(f" -> Server [{s_name.upper()}]: {'ONLINE 🟢' if s_ok else 'FAILED TO BOOT 🔴'}")

    runner = LlamaCppBenchmarkRunner(thinking_mode="auto")

    t_global_start = time.time()

    # Run Suite A1: Auto-Thinking
    suite_a1 = run_suite_a_policy_verification(client)

    # Run Suite A2: Auto-Context
    suite_a2 = run_suite_a2_context_verification(client)

    # Run Suite A3: Auto-Model Selection
    suite_a3 = run_suite_a3_model_policy_verification(client)

    # Run Suite B: Production Repo
    suite_b = run_suite_b_production_repo(runner)

    # Run Suite C: SWE-Bench Lite Mini
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
    print(f"{suite_a3['suite']:<40} | {'PASS' if suite_a3['passed'] else 'FAIL':<10} | {suite_a3['passed_tests']}/{suite_a3['total_tests']:<8} | {'<0.1s':<8}")
    print(f"{suite_b['suite']:<40} | {'PASS' if suite_b['passed'] else 'FAIL':<10} | {suite_b['pass_count']}/{suite_b['total_tasks']:<8} | {str(suite_b['total_latency'])+'s':<8}")
    print(f"{suite_c['suite']:<40} | {'PASS' if suite_c['passed'] else 'FAIL':<10} | {suite_c['pass_count']}/{suite_c['total_tasks']:<8} | {str(suite_c['total_latency'])+'s':<8}")
    print("-" * 76)
    total_passed = suite_a1["passed_tests"] + suite_a2["passed_tests"] + suite_a3["passed_tests"] + suite_b["pass_count"] + suite_c["pass_count"]
    total_count = suite_a1["total_tests"] + suite_a2["total_tests"] + suite_a3["total_tests"] + suite_b["total_tasks"] + suite_c["total_tasks"]
    overall_pct = (total_passed / total_count) * 100
    print(f"{'OVERALL BATTERY COMPOSITE':<40} | {'PASS' if overall_pct == 100 else 'PARTIAL':<10} | {total_passed}/{total_count} ({overall_pct:.1f}%) | {total_battery_time:.2f}s")
    print("=" * 80)

    # Save structured results
    summary_data = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "backend": "llama.cpp (Metal)",
        "model_mode": mode,
        "thinking_mode": "auto",
        "context_mode": "auto",
        "total_time_sec": round(total_battery_time, 2),
        "overall_pass_rate_pct": round(overall_pct, 1),
        "suite_a1_thinking_policy": suite_a1,
        "suite_a2_context_policy": suite_a2,
        "suite_a3_model_policy": suite_a3,
        "suite_b_requests_repo": suite_b,
        "suite_c_swe_bench_mini": suite_c
    }

    with open("results/full_battery_eval_report.json", "w") as fp:
        json.dump(summary_data, fp, indent=2)
    print("\nSaved full battery structured data to results/full_battery_eval_report.json")

    return summary_data

if __name__ == "__main__":
    run_full_battery()
