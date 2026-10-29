"""
Throughput benchmark for llama-server parallel slots. Sends 1, 4, 8, and 16 concurrent completion requests and
reports aggregate and per-stream speed. Writes results/parallel_slots_benchmark.json.

Usage: python3 benchmark_parallel_slots.py [--port 8081] [--tokens 60]
"""

import argparse
import ast
import json
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SIGNATURES = [
    'def add(a: int, b: int) -> int:\n    """Add two numbers."""',
    'def is_even(n: int) -> bool:\n    """Return True if even."""',
    'def square(x: float) -> float:\n    """Square a number."""',
    'def get_length(s: str) -> int:\n    """Return string length."""',
    'def negate(b: bool) -> bool:\n    """Negate boolean."""',
    'def first_item(lst: list):\n    """Return first element or None."""',
    'def to_upper(s: str) -> str:\n    """Convert to uppercase."""',
    'def clamp(val: float, low: float, high: float) -> float:\n    """Clamp value between low and high."""',
    'def is_positive(x: int) -> bool:\n    """Return True if positive."""',
    'def double(n: int) -> int:\n    """Multiply by two."""',
    'def abs_val(x: float) -> float:\n    """Absolute value."""',
    'def is_empty(seq) -> bool:\n    """Check if empty sequence."""',
    'def list_sum(nums: list) -> float:\n    """Sum numbers."""',
    'def min_val(a, b):\n    """Return minimum of two values."""',
    'def max_val(a, b):\n    """Return maximum of two values."""',
    'def greet(name: str) -> str:\n    """Return greeting string."""',
]


def complete(signature: str, max_tokens: int, port: int):
    prompt = (
        "<|im_start|>system\nEmit only valid Python code.\n<|im_end|>\n"
        f"<|im_start|>user\nComplete the following function:\n```python\n{signature}\n```\n<|im_end|>\n"
        f"<|im_start|>assistant\n```python\n{signature}\n"
    )
    payload = {"prompt": prompt, "n_predict": max_tokens, "temperature": 0.0, "stop": ["```", "<|im_end|>", "<|endoftext|>"]}
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/completion", data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=30.0) as resp:
            data = json.load(resp)
    except (OSError, ValueError):
        return None
    try:
        ast.parse(f"{signature}\n{data['content']}")
        valid = True
    except SyntaxError:
        valid = False
    return {"duration": time.time() - t0, "tokens": data["tokens_predicted"], "ast_valid": valid}


def run_tier(concurrency: int, max_tokens: int, port: int):
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        results = list(pool.map(lambda i: complete(SIGNATURES[i % len(SIGNATURES)], max_tokens, port), range(concurrency)))
    wall = time.time() - t0
    ok = [r for r in results if r]
    tokens = sum(r["tokens"] for r in ok)
    return {
        "concurrency": concurrency,
        "wall_clock": round(wall, 2),
        "errors": concurrency - len(ok),
        "aggregate_tok_sec": round(tokens / wall, 1),
        "per_stream_tok_sec": round(sum(r["tokens"] / r["duration"] for r in ok) / len(ok), 1) if ok else 0.0,
        "ast_valid": sum(r["ast_valid"] for r in ok),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8081)
    parser.add_argument("--tokens", type=int, default=60, help="max tokens per request")
    args = parser.parse_args()

    print(f"{'Concurrency':<12} {'Wall':>8} {'Aggregate':>14} {'Per stream':>14} {'AST valid':>10} {'Errors':>7}")
    results = []
    for concurrency in (1, 4, 8, 16):
        r = run_tier(concurrency, args.tokens, args.port)
        results.append(r)
        print(f"{concurrency:<12} {r['wall_clock']:>7}s {r['aggregate_tok_sec']:>8} tok/s {r['per_stream_tok_sec']:>8} tok/s "
              f"{r['ast_valid']:>6}/{concurrency:<3} {r['errors']:>7}")

    report = Path("results/parallel_slots_benchmark.json")
    report.parent.mkdir(exist_ok=True)
    report.write_text(json.dumps(results, indent=2))
    print(f"\nSaved {report}")


if __name__ == "__main__":
    main()
