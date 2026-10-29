# LFM3 1.7B Local Swarm Benchmark & Testing System

A reproducible framework for testing swarms using the **LFM3 1.7B** model (`lfm3:latest`) on local Apple Silicon / CPU hardware via Ollama.

## Quickstart

### 1. Ensure Ollama & Model are Ready
```bash
ollama list
# If lfm3 is not installed:
ollama run lfm3:latest
```

### 2. Determine Safe Swarm Sizing
Calculates RAM, unified memory headroom, and CPU core boundaries:
```bash
python3 resource_monitor.py
```

### 3. Run the Full Swarm Benchmark Suite
Executes scaling benchmarks (Map-Reduce collaborative swarm), followed by a multi-agent consensus debate test:
```bash
# Standard direct inference mode
python3 benchmark_runner.py

# Or enable LFM3 Thinking / Reasoning mode
python3 benchmark_runner.py --think
```

## System Architecture

- [`resource_monitor.py`](file:///Users/christian/Documents/lfm-test/resource_monitor.py): Dynamic hardware profiling (`sysctl`, `vm_stat`, unified memory margins).
- [`ollama_client.py`](file:///Users/christian/Documents/lfm-test/ollama_client.py): Direct HTTP client with token telemetry, latency tracking, and error handling.
- [`swarm_engine.py`](file:///Users/christian/Documents/lfm-test/swarm_engine.py): Implements Map-Reduce (collaborative specialist agents + chief synthesizer) and Consensus Debate (adversarial agents + impartial judge).
- [`benchmark_runner.py`](file:///Users/christian/Documents/lfm-test/benchmark_runner.py): Orchestrates tests across agent scaling tiers and compiles Markdown + JSON assessment reports.

## Generated Artifacts

- Summary Assessment: [`results/SWARM_ASSESSMENT.md`](file:///Users/christian/Documents/lfm-test/results/SWARM_ASSESSMENT.md)
- Structured Data: [`results/swarm_evaluation_report.json`](file:///Users/christian/Documents/lfm-test/results/swarm_evaluation_report.json)
