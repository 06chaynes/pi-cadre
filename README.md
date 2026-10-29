# LFM3 1.7B Local Swarm Benchmark & Testing System

A reproducible framework for testing swarms using the **LFM3 1.7B** model (`LiquidAI/LFM3-1.7B-GGUF:Q4_K_M`) on local Apple Silicon hardware.

**Default Inference Backend:** `llama.cpp` (`llama-server` on Metal, port 8080) with `--parallel 4` concurrent slots.  
**Default Thinking Policy:** `"auto"` (intelligently enables or disables `<think>` tokens based on task intent and runtime feedback).

## Quickstart

### 1. Launch Default Inference Backend (llama.cpp Metal)
```bash
llama-server -hf LiquidAI/LFM3-1.7B-GGUF:Q4_K_M -ngl 99 --parallel 4 --ctx-size 8192 --port 8080
```

### 2. Run the Real-World Production Repository Benchmark (psf/requests - 15k LOC)
Evaluates 4 real-world production defects with 100% test pass rate using our 4 foundational architectural refinements:
```bash
python run_llama_cpp_repo_benchmark.py
```

### 3. "Auto" Thinking Policy
The framework introduces `AutoThinkingPolicy` in `llama_cpp_client.py`:
- **Code Synthesis & Micro-Editing:** Thinking is automatically disabled and steered via Prefix Pre-Filling (`<|im_start|>assistant\n```python\n{signature}`) to bypass reasoning budget exhaustion and stream clean syntax in <300ms.
- **GBNF / JSON Schema Decoding:** Thinking is disabled to enforce strict, immediate first-token JSON compliance.
- **Error Traceback & Self-Healing:** Thinking is dynamically elevated when complex assertion errors or multi-step logic regressions are detected.

```bash
# Run with Auto-Thinking (default)
python run_llama_cpp_repo_benchmark.py

# Or explicitly force thinking on/off
python run_llama_cpp_repo_benchmark.py --thinking-mode on
python run_llama_cpp_repo_benchmark.py --thinking-mode off
```

## System Architecture

- [`resource_monitor.py`](file:///Users/christian/Documents/lfm-test/resource_monitor.py): Dynamic hardware profiling (`sysctl`, `vm_stat`, unified memory margins).
- [`ollama_client.py`](file:///Users/christian/Documents/lfm-test/ollama_client.py): Direct HTTP client with token telemetry, latency tracking, and error handling.
- [`swarm_engine.py`](file:///Users/christian/Documents/lfm-test/swarm_engine.py): Implements Map-Reduce (collaborative specialist agents + chief synthesizer) and Consensus Debate (adversarial agents + impartial judge).
- [`benchmark_runner.py`](file:///Users/christian/Documents/lfm-test/benchmark_runner.py): Orchestrates tests across agent scaling tiers and compiles Markdown + JSON assessment reports.

## Generated Artifacts

- Summary Assessment: [`results/SWARM_ASSESSMENT.md`](file:///Users/christian/Documents/lfm-test/results/SWARM_ASSESSMENT.md)
- Structured Data: [`results/swarm_evaluation_report.json`](file:///Users/christian/Documents/lfm-test/results/swarm_evaluation_report.json)
