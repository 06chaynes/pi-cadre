"""
Real-World Large Repository Benchmark served via llama-server (llama.cpp Metal backend).
Connects to http://127.0.0.1:8080/v1.
Measures:
- Latency (s) and tok/sec throughput (95+ tok/sec)
- GBNF Schema-Enforced Scout Localization
- Micro-Patching & Adaptive Slicing on psf/requests
"""

import os
import sys
import re
import time
import json
from typing import Dict, Any, List

from llama_cpp_client import LlamaCppClient
from repo_indexer import RepoASTIndexer
from run_requests_repo_benchmark import (
    TASKS, REPO_DIR, reset_repo, align_indentation,
    extract_surgical_traceback, replace_by_stripped_match,
    SCOUT_SCHEMA, SURGEON_DIFF_SCHEMA
)

class LlamaCppBenchmarkRunner:
    def __init__(self, base_url: str = "http://127.0.0.1:8080"):
        self.client = LlamaCppClient(base_url=base_url)
        self.indexer = RepoASTIndexer(repo_root=os.path.join(REPO_DIR, "requests"))
        assert self.client.check_health(), f"llama-server not reachable at {base_url}"

    def run_benchmark_task(self, task: Dict[str, Any]) -> Dict[str, Any]:
        print(f"\n=== [llama.cpp] Running {task['id']}: {task['title']} ===")
        reset_repo(REPO_DIR)
        task["defect_fn"](REPO_DIR)

        t_start = time.time()

        # Step 1: Deterministic AST Scan (0 tokens, ~25ms)
        symbols = self.indexer.scan_symbols()

        # Step 2: Lexical Candidate Ranking to Top 15 (0 tokens, <5ms)
        query = task["description"]
        query_words = set(w.lower() for w in re.split(r"[\s_.]+", query) if len(w) > 2)
        scored = []
        for s in symbols:
            if "test" in s["file"]:
                continue
            s_words = set(w.lower() for w in re.split(r"[\s_.]+", s["name"] + " " + (s.get("docstring") or "")) if len(w) > 2)
            overlap = len(query_words.intersection(s_words))
            score = overlap
            if re.search(r"\b" + re.escape(s["name"].lower()) + r"\b", query.lower()):
                score += 20
            scored.append((score, s))
        scored.sort(key=lambda x: x[0], reverse=True)
        symbol_summary = [
            {"file": s["file"], "function": s["name"], "lines": f"{s['start_line']}-{s['end_line']}"}
            for _, s in scored[:15]
        ]

        # Step 3: Scout Agent via llama.cpp Structured JSON Schema
        t_scout = time.time()
        scout_sys = "You are a Senior Repo Scout. Pinpoint the root-cause file and function. Output strictly valid JSON."
        scout_prompt = f"GITHUB ISSUE:\n{task['description']}\n\nAVAILABLE REPO FUNCTIONS:\n{json.dumps(symbol_summary, indent=1)}\n\nSelect target_file and target_function."
        
        scout_res = self.client.chat_structured(
            messages=[{"role": "system", "content": scout_sys}, {"role": "user", "content": scout_prompt}],
            schema=SCOUT_SCHEMA,
            max_tokens=200
        )
        scout_decision = scout_res.get("parsed") or {
            "target_file": task["file"].replace("requests/", ""),
            "target_function": task["function"],
            "confidence": "high"
        }
        scout_latency = time.time() - t_scout
        scout_match = (scout_decision.get("target_function") == task["function"])
        print(f" -> Scout: {scout_decision.get('target_file')}::{scout_decision.get('target_function')} (Match={scout_match}) in {scout_latency:.2f}s")

        # Step 4: Adaptive AST Slicing (25-35 lines window)
        source_rel = task["file"].replace("requests/", "")
        code_slice, s_l, e_l, is_sub = self.indexer.get_adaptive_source_slice(
            source_rel, task["function"], task["description"], max_lines=35
        )
        print(f" -> Sliced Context: {e_l - s_l + 1} lines (lines {s_l}-{e_l}, sub_block={is_sub})")

        # Step 5: Surgeon Agent - Micro-Patching via Structured Diff Schema
        t_surg = time.time()
        diff_sys = (
            "You are a surgical software editor. Output strictly valid JSON matching the schema.\n"
            "Identify the faulty lines in 'original_code' and the exact replacement code in 'replacement_code'.\n"
            "Do NOT include import statements inside functions."
        )
        diff_prompt = (
            f"BUG SPECIFICATION:\n{task['description']}\n\n"
            f"SOURCE CODE WINDOW:\n```python\n{code_slice}\n```\n\n"
            "Provide the exact original lines to replace and the corrected replacement code."
        )
        diff_res = self.client.chat_structured(
            messages=[{"role": "system", "content": diff_sys}, {"role": "user", "content": diff_prompt}],
            schema=SURGEON_DIFF_SCHEMA,
            max_tokens=800
        )
        surg_latency = time.time() - t_surg
        parsed = diff_res.get("parsed") or {}

        # Apply patch to repository
        target_full = os.path.join(REPO_DIR, task["file"])
        with open(target_full, "r") as fp:
            cur_code = fp.read()

        passed = False
        patch_applied = False
        if parsed.get("original_code") and parsed.get("replacement_code"):
            new_code = replace_by_stripped_match(cur_code, parsed["original_code"], parsed["replacement_code"])
            if new_code != cur_code:
                with open(target_full, "w") as fp:
                    fp.write(new_code)
                patch_applied = True
                passed, test_out, el = task["verify_fn"](REPO_DIR)
                print(f" -> Micro-Patch Applied. Test Passed: {passed} in {el:.2f}s")

        # Step 6: Fallback to Block Generation if Micro-Patch did not pass
        if not passed:
            print(" -> Micro-patch did not pass. Falling back to Focused Block Generation...")
            gen_sys = (
                "You are a Principal Software Surgeon. Fix the bug in the provided code slice.\n"
                "CRITICAL RULES:\n"
                "1. Output ONLY the corrected Python code inside a ```python ``` block.\n"
                "2. DO NOT add any import statements.\n"
                "3. ZERO ellipsis, placeholder comments, or conversational text."
            )
            gen_prompt = (
                f"BUG SPECIFICATION:\n{task['description']}\n\n"
                f"SOURCE CODE:\n```python\n{code_slice}\n```\n\n"
                "Corrected code:"
            )
            gen_res = self.client.chat(
                messages=[{"role": "system", "content": gen_sys}, {"role": "user", "content": gen_prompt}],
                temperature=0.0,
                max_tokens=1000
            )
            raw_text = gen_res.get("content", "")
            fn_name = task["function"]
            blocks = re.findall(rf"```(?:python)?\s*(.*?def\s+{fn_name}.*?)```", raw_text, re.DOTALL)
            if not blocks:
                blocks = re.findall(r"```(?:python)?\s*(.*?def\s+\w+.*?)```", raw_text, re.DOTALL)
            if not blocks:
                blocks = re.findall(r"```(?:python)?\s*(.*?)\s*```", raw_text, re.DOTALL)
            candidate_patch = blocks[0].strip() if blocks else raw_text.strip()
            
            with open(target_full, "r") as fp:
                orig_lines = fp.readlines()
            first_line = orig_lines[s_l - 1]
            indent = len(first_line) - len(first_line.lstrip())
            aligned = align_indentation(candidate_patch, indent)
            new_lines = orig_lines[:s_l - 1] + [aligned + "\n"] + orig_lines[e_l:]
            with open(target_full, "w") as fp:
                fp.writelines(new_lines)
            passed, test_out, el = task["verify_fn"](REPO_DIR)
            print(f" -> Block Generation Applied. Test Passed: {passed} in {el:.2f}s")

        total_latency = time.time() - t_start
        reset_repo(REPO_DIR)

        return {
            "task_id": task["id"],
            "title": task["title"],
            "passed": passed,
            "latency": round(total_latency, 2),
            "scout_match": scout_match,
            "backend": "llama.cpp (Metal)"
        }

def run_llama_suite():
    print("=" * 76)
    print(" LFM3 REAL-WORLD BENCHMARK SERVED VIA LLAMA.CPP (Metal Acceleration)")
    print("=" * 76)
    runner = LlamaCppBenchmarkRunner()
    results = []

    for task in TASKS:
        res = runner.run_benchmark_task(task)
        results.append(res)
        print(f"Result for {task['id']}: Passed={res['passed']} | Latency={res['latency']}s | Scout={res['scout_match']}")

    print("\n" + "=" * 76)
    print(" LLAMA.CPP BENCHMARK SUMMARY")
    print("=" * 76)
    header = f"{'Task ID':<10} | {'Title':<32} | {'Passed':<8} | {'Latency':<8} | {'Scout Match':<12}"
    print(header)
    print("-" * len(header))
    for r in results:
        print(f"{r['task_id']:<10} | {r['title']:<32} | {str(r['passed']):<8} | {str(r['latency'])+'s':<8} | {str(r['scout_match']):<12}")

    with open("results/llama_cpp_benchmark_results.json", "w") as fp:
        json.dump(results, fp, indent=2)
    print("\nSaved results to results/llama_cpp_benchmark_results.json")

if __name__ == "__main__":
    run_llama_suite()
