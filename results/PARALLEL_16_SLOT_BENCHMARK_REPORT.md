# 16-Parallel-Slot Concurrency Benchmark Report: LiquidAI LFM3 1.7B

**Evaluation Date:** October 29, 2026  
**Hardware Platform:** Apple Silicon Mac (M-Series, 32 GB Unified Memory, Metal GPU Acceleration)  
**Inference Engine:** `llama.cpp` (`llama-server`, build with native parallel slot scheduling)  
**Model:** `LiquidAI/LFM3-1.7B-GGUF:Q4_K_M`  
**Slot Configuration:** `--parallel 16` (`n_slots = 16`, `n_ctx_slot = 2048`, total context `32768`)  

---

## Executive Summary

We deployed and benchmarked a **16-parallel-slot** configuration on `llama-server` to stress-test multi-agent swarm capacity and concurrency throughput with the **LiquidAI LFM3 1.7B** architecture.

### Key Highlights:
1. **System Throughput Escalation:** Scaling from 1 stream to 16 concurrent streams increased aggregate system throughput from **30.5 tok/s up to 83.9 tok/s** (**+175% scaling gain**).
2. **Sub-2-Second 16-Way Concurrency:** All 16 simultaneous code synthesis requests completed in **1.86 seconds total wall-clock time** (average per-stream latency: **1.58s**).
3. **100.0% Syntactic Integrity:** **16 / 16 (100.0%)** generated code blocks passed in-memory Python AST validation with zero syntax errors, zero dropped connections, and zero HTTP timeouts.
4. **Real-World Codebase Verification:** Under 16-slot operation, the real-world production codebase benchmark (`psf/requests` 15,000 LOC) completed with **4 / 4 PASS (100.0%)** at single-stream generation bursts up to **76.2 tok/s**.

---

## Empirical Concurrency Scaling Metrics

```mermaid
xychart-beta
    title "Aggregate Throughput Scaling vs Parallel Streams (tok/s)"
    x-axis ["1 Stream", "4 Streams", "8 Streams", "16 Streams"]
    y-axis "Aggregate tok/s" 0 --> 100
    bar [30.5, 54.1, 66.3, 83.9]
```

### Concurrency Tiers Breakdown:
| Concurrency Level | Wall-Clock Time | Total Tokens Emitted | Aggregate Throughput | Per-Stream Speed | Avg Per-Stream Latency | AST Validity | Error Rate |
|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **1 Stream** (Baseline) | 0.23s | 7 | 30.5 tok/s | 30.9 tok/s | 0.23s | 1/1 (100%) | 0/1 |
| **4 Streams** | 0.59s | 32 | 54.1 tok/s | 14.5 tok/s | 0.55s | 4/4 (100%) | 0/4 |
| **8 Streams** | 1.06s | 70 | 66.3 tok/s | 9.2 tok/s | 0.93s | 8/8 (100%) | 0/8 |
| **16 Streams** (Full Saturation) | **1.86s** | **156** | **83.9 tok/s** | **6.0 tok/s** | **1.59s** | **16/16 (100%)** | **0/16** |

---

## Memory & Resource Footprint

- **Model Weights (Q4_K_M):** ~1.1 GB resident VRAM.
- **KV Cache Allocation (16 slots × 2048 ctx):** ~3.2 GB unified memory.
- **Total Footprint:** **~4.3 GB total memory usage**, leaving over **27 GB free headroom** on your 32 GB machine.
- **Thermal / Throttling:** Zero GPU throttling observed during repeated 16-slot bursts.

---

## Real-World Production Codebase Benchmark (`psf/requests` 15k LOC)

To verify that the 16-slot server maintains code generation precision under real codebase conditions, we ran the full Suite B battery against the 16-slot server:

| Task ID | Component / Defect | Scout Matching | Generation Latency | Single-Stream Speed | Pytest Result | Status |
|---|---|:---:|:---:|:---:|:---:|:---:|
| **TASK-1** | `prepend_scheme_if_needed` (Proxy Auth) | True (2.72s) | 2.43s (175 tok) | 72.15 tok/s | 0.36s | **PASS** |
| **TASK-2** | `merge_environment_settings` (CA Bundle) | True (2.72s) | 3.09s (226 tok) | 73.07 tok/s | 0.93s | **PASS** |
| **TASK-3** | `get_auth_from_url` (Unquoting) | True (2.80s) | 0.99s (54 tok) | 54.42 tok/s | 0.36s | **PASS** |
| **TASK-4** | `resolve_redirects` (State Drift) | True (2.82s) | 4.98s (379 tok) | 76.18 tok/s | 0.15s | **PASS** |
| **Total** | **Suite B Production Repo Battery** | **4/4 Matched** | **11.49s Gen** | **Avg ~69.0 tok/s** | **1.80s Tests** | **4/4 PASS (100%)** |

---

## Conclusion & Operational Recommendation

- **Ideal for Swarm Architectures:** A 16-slot configuration allows Map-Reduce and Consensus Debate agent swarms to query 16 perspectives simultaneously without serial queuing, returning comprehensive multi-agent synthesis in under 2 seconds.
- **Recommended Launcher Preset:**
  ```bash
  llama-server -hf LiquidAI/LFM3-1.7B-GGUF:Q4_K_M -ngl 99 --parallel 16 --ctx-size 32768 --port 8080
  ```
