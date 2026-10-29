"""
Concurrent Parallel Slot Benchmark for LFM3 1.7B on llama-server.
Evaluates system throughput, token speed, and per-stream latency across:
- 1 concurrent worker (Single stream baseline)
- 4 concurrent workers
- 8 concurrent workers
- 16 concurrent workers (Full 16-slot saturation)
"""

import urllib.request
import urllib.error
import json
import time
import ast
import argparse
import concurrent.futures
from typing import Dict, Any, List

SERVER_URL = "http://127.0.0.1:8081"
MODEL_ID = "LiquidAI/LFM3-1.7B-GGUF:Q4_K_M"

TEST_PROMPTS = [
    ("def add(a: int, b: int) -> int:\n    \"\"\"Add two numbers.\"\"\"", "return a + b"),
    ("def is_even(n: int) -> bool:\n    \"\"\"Return True if even.\"\"\"", "return n % 2 == 0"),
    ("def square(x: float) -> float:\n    \"\"\"Square a number.\"\"\"", "return x * x"),
    ("def get_length(s: str) -> int:\n    \"\"\"Return string length.\"\"\"", "return len(s)"),
    ("def negate(b: bool) -> bool:\n    \"\"\"Negate boolean.\"\"\"", "return not b"),
    ("def first_item(lst: list):\n    \"\"\"Return first element or None.\"\"\"", "return lst[0] if lst else None"),
    ("def to_upper(s: str) -> str:\n    \"\"\"Convert to uppercase.\"\"\"", "return s.upper()"),
    ("def clamp(val: float, low: float, high: float) -> float:\n    \"\"\"Clamp value between low and high.\"\"\"", "return max(low, min(val, high))"),
    ("def is_positive(x: int) -> bool:\n    \"\"\"Return True if positive.\"\"\"", "return x > 0"),
    ("def double(n: int) -> int:\n    \"\"\"Multiply by two.\"\"\"", "return n * 2"),
    ("def abs_val(x: float) -> float:\n    \"\"\"Absolute value.\"\"\"", "return abs(x)"),
    ("def is_empty(seq) -> bool:\n    \"\"\"Check if empty sequence.\"\"\"", "return len(seq) == 0"),
    ("def list_sum(nums: list) -> float:\n    \"\"\"Sum numbers.\"\"\"", "return sum(nums)"),
    ("def min_val(a, b):\n    \"\"\"Return minimum of two values.\"\"\"", "return a if a < b else b"),
    ("def max_val(a, b):\n    \"\"\"Return maximum of two values.\"\"\"", "return a if a > b else b"),
    ("def greet(name: str) -> str:\n    \"\"\"Return greeting string.\"\"\"", "return f'Hello, {name}'")
]

def make_request(prompt_sig: str, max_tokens: int = 60, port: int = 8081) -> Dict[str, Any]:
    full_prompt = (
        "<|im_start|>system\nEmit only valid Python code.\n<|im_end|>\n"
        f"<|im_start|>user\nComplete the following function:\n```python\n{prompt_sig}\n```\n<|im_end|>\n"
        f"<|im_start|>assistant\n```python\n{prompt_sig}\n"
    )

    payload = {
        "prompt": full_prompt,
        "n_predict": max_tokens,
        "temperature": 0.0,
        "stop": ["```", "<|im_end|>", "<|endoftext|>"]
    }

    t0 = time.time()
    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/completion",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=30.0) as resp:
            data = json.loads(resp.read().decode())
            dur = time.time() - t0
            content = data.get("content", "")
            tokens = data.get("tokens_predicted", 0)
            completed_code = f"{prompt_sig}\n{content}"

            # Validate syntax
            is_valid = False
            try:
                ast.parse(completed_code)
                is_valid = True
            except Exception:
                is_valid = False

            return {
                "success": True,
                "duration": dur,
                "tokens": tokens,
                "tok_per_sec": (tokens / dur) if dur > 0 else 0.0,
                "ast_valid": is_valid,
                "code": completed_code
            }
    except Exception as e:
        return {
            "success": False,
            "duration": time.time() - t0,
            "tokens": 0,
            "tok_per_sec": 0.0,
            "ast_valid": False,
            "error": str(e)
        }

def run_tier(concurrency: int, max_tokens: int = 60, port: int = 8081) -> Dict[str, Any]:
    print(f"\n" + "-" * 70)
    print(f" TESTING CONCURRENCY TIER: {concurrency} PARALLEL REQUESTS (Max Tokens: {max_tokens})")
    print("-" * 70)

    prompts = [TEST_PROMPTS[i % len(TEST_PROMPTS)][0] for i in range(concurrency)]

    t_start = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = [executor.submit(make_request, p, max_tokens, port) for p in prompts]
        results = [f.result() for f in futures]
    wall_clock = time.time() - t_start

    successful = [r for r in results if r["success"]]
    total_tokens = sum(r["tokens"] for r in successful)
    valid_ast = sum(1 for r in successful if r["ast_valid"])
    avg_per_stream_latency = sum(r["duration"] for r in successful) / len(successful) if successful else 0.0
    avg_per_stream_tok_sec = sum(r["tok_per_sec"] for r in successful) / len(successful) if successful else 0.0
    aggregate_tok_sec = total_tokens / wall_clock if wall_clock > 0 else 0.0

    print(f" • Concurrency Level:      {concurrency} parallel streams")
    print(f" • Wall-Clock Duration:    {wall_clock:.2f}s")
    print(f" • Total Tokens Emitted:   {total_tokens} tokens")
    print(f" • Aggregate Throughput:   {aggregate_tok_sec:.2f} tok/s  <-- SYSTEM CAPACITY")
    print(f" • Per-Stream Speed:       {avg_per_stream_tok_sec:.2f} tok/s per agent")
    print(f" • Per-Stream Latency:     {avg_per_stream_latency:.2f}s per request")
    print(f" • AST Validity Rate:      {valid_ast}/{concurrency} ({valid_ast/concurrency*100:.1f}%)")
    print(f" • Error Rate:             {concurrency - len(successful)}/{concurrency}")

    return {
        "concurrency": concurrency,
        "max_tokens": max_tokens,
        "wall_clock": wall_clock,
        "total_tokens": total_tokens,
        "aggregate_tok_sec": aggregate_tok_sec,
        "avg_per_stream_tok_sec": avg_per_stream_tok_sec,
        "avg_per_stream_latency": avg_per_stream_latency,
        "ast_valid_count": valid_ast,
        "success_count": len(successful)
    }

def main():
    parser = argparse.ArgumentParser(description="LFM3 1.7B Parallel Slot Benchmark")
    parser.add_argument("--port", type=int, default=8081, help="Port of llama-server")
    parser.add_argument("--tokens", type=int, default=60, help="Max tokens per request")
    args = parser.parse_args()

    print("=" * 76)
    print(f" LFM3 1.7B PARALLEL SLOT CONCURRENCY BENCHMARK ({args.port})")
    print(f" Target Server: http://127.0.0.1:{args.port} | Model: {MODEL_ID}")
    print("=" * 76)

    tiers = [1, 4, 8, 16]
    results = []
    for t in tiers:
        res = run_tier(t, max_tokens=args.tokens, port=args.port)
        results.append(res)
        time.sleep(0.5)

    print("\n" + "=" * 76)
    print(" COMPOSITE SCALING SUMMARY")
    print("=" * 76)
    print(f"{'Concurrency':<12} | {'Wall-Clock':<10} | {'Aggregate Tok/s':<18} | {'Per-Stream Speed':<18} | {'AST Valid':<10}")
    print("-" * 76)
    for r in results:
        print(f"{r['concurrency']:<12} | {r['wall_clock']:>8.2f}s | {r['aggregate_tok_sec']:>14.1f} tok/s | {r['avg_per_stream_tok_sec']:>14.1f} tok/s | {r['ast_valid_count']}/{r['concurrency']} PASS")
    print("=" * 76)

    # Save to JSON
    with open("results/parallel_16_benchmark.json", "w") as fp:
        json.dump(results, fp, indent=2)
    print("\nDetailed benchmark results saved to results/parallel_16_benchmark.json")

if __name__ == "__main__":
    main()
