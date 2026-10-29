# Pi & LiquidAI LFM3 1.7B Swarm Framework

A production-grade, reproducible framework and cross-platform coding assistant integration for **LiquidAI LFM3 1.7B** (`LiquidAI/LFM3-1.7B-GGUF:Q4_K_M`) coupled with **Pi Coding Agent** (`@earendil-works/pi-coding-agent`).

- **Primary Backend:** `llama.cpp` (`llama-server`, 42.1 tok/s, GPU acceleration via Metal/CUDA, 4 parallel slots)
- **Alternative Backend:** `Ollama` (`lfm3:latest`, 31.7 tok/s)
- **Auto-Thinking Policy:** Dynamically switches `<think>` tokens on or off based on task intent, schema constraints, and traceback retry telemetry.
- **Full Test Battery Pass Rate:** **15 / 15 (100.0%)** across Auto-Thinking Policy verification, production repository benchmarks (`psf/requests` 15,000 LOC), and multi-repo SWE-Bench Lite tasks.

---

## ⚡ 1-Click Guided Installation Wizard

A portable, interactive wizard installs and configures the inference backend (`llama.cpp` or `ollama`), the LFM3 GGUF model, Pi Coding Agent, and deploys all foundational customizations.

### macOS & Linux
```bash
./install.sh
```
*(or `python3 setup_wizard.py`)*

### Windows (PowerShell or Command Prompt)
```powershell
.\install.ps1
```
*(or `install.bat` / `python setup_wizard.py`)*

### Unattended / CI Mode
```bash
# Automated install using llama.cpp as default backend
python3 setup_wizard.py --unattended --backend llama.cpp

# Or preview actions without writing
python3 setup_wizard.py --dry-run
```

---

## 🚀 Running the Stack

### 1. Start the Inference Server
```bash
# macOS / Linux
./launchers/start_llama_server.sh

# Windows
.\launchers\start_llama_server.bat
```
This boots `llama-server` on `http://127.0.0.1:8080` with `--parallel 4 -ngl 99 --ctx-size 8192` and downloads/serves `LiquidAI/LFM3-1.7B-GGUF:Q4_K_M`.

### 2. Launch Pi with LFM3 Optimizations
```bash
# macOS / Linux
./launchers/pi_lfm3.sh

# Windows
.\launchers\pi_lfm3.bat
```

Inside Pi interactive chat:
- `/lfm3-status` — check backend connection latency, model status, and memory.
- `/lfm3-thinking auto` — toggle between `auto`, `off`, `low`, `medium`, or `high`.

---

## 🧠 Foundational Optimizations

Unlike brittle per-test workarounds, this framework applies 4 foundational architectural improvements engineered specifically for the LFM3 1.7B architecture:

```mermaid
flowchart TD
    UserReq["User Request / Repo Task"] --> Policy["AutoThinkingPolicy"]
    Policy -->|Intent == Code / Micro-Edit| Prefix["Prefix Pre-Filling (<|im_start|>assistant\n```python\n{sig})"]
    Policy -->|Intent == Diagnosis / Traceback Retry| Think["Reasoning Activated (<think>)"]
    Prefix --> LFM3["LFM3 1.7B GGUF Model"]
    Think --> LFM3
    LFM3 --> AST_Strip["AST Docstring Stripping"]
    AST_Strip --> AST_San["AST Inner-Import Sanitizer"]
    AST_San --> Indent["Relative Indentation Preserver"]
    Indent --> AST_Gate{"In-Memory AST Gate"}
    AST_Gate -->|Valid AST| Apply["Atomic Disk Patch & Pytest"]
    AST_Gate -->|Syntax Error| Retry["Feedback Loop to LFM3"]
```

1. **Auto-Thinking Policy (`AutoThinkingPolicy`):**
   - **Code Synthesis & Micro-Editing:** Thinking is automatically disabled and steered via Prefix Pre-Filling to bypass token budget exhaustion and achieve instant code delivery in <300ms.
   - **GBNF / JSON Schema Decoding:** Thinking is disabled to enforce strict, immediate first-token JSON compliance.
   - **Error Tracebacks & Diagnostic Retries:** Reasoning is dynamically activated (`<think>`) when assertion errors or complex traceback regressions are encountered.
2. **Prefix Pre-Filling:**
   - Pre-fills the assistant turn with `<|im_start|>assistant\n```python\n{signature}`. This eliminates repetitive conversational preambles ("Certainly! Here is...") and guarantees syntactic alignment with the target module.
3. **AST Docstring Stripping & Module-Bound Context:**
   - Strips multi-line docstrings from injected dependencies to reduce prompt bloat by ~50% while preserving exact type signatures and caller contracts.
4. **AST Inner-Import Sanitizer & Relative Indentation:**
   - Traverses the generated function AST to strip hallucinated imports introduced into local function scopes, and normalizes indentation relative to the caller scope before committing changes.

---

## 📊 Verification & Test Battery Results

Run the complete 15-task battery against `llama-server`:

```bash
python3 run_full_battery_eval.py
```

### Full Battery Scorecard:
| Test Suite | Focus Area | Tasks | Pass Rate | Runtime |
|---|---|:---:|:---:|:---:|
| **Suite A** | Auto-Thinking Policy & Decision Logic | 6 | **100.0%** (6/6) | 0.05s |
| **Suite B** | Real-World Codebase (`psf/requests` 15,000 LOC) | 4 | **100.0%** (4/4) | 24.38s |
| **Suite C** | Multi-Repo SWE-Bench Lite (Django, Pytest, Requests, Astropy) | 5 | **100.0%** (5/5) | 4.01s |
| **Composite** | **All Benchmark Suites** | **15** | **100.0% (15/15)** | **28.39s** |

### Speed Comparison: llama.cpp vs Ollama
| Metric | Ollama (`lfm3:latest`) | llama.cpp (`LFM3-1.7B-GGUF`) | Delta |
|---|:---:|:---:|:---:|
| **Generation Speed** | 31.7 tok/s | **42.1 tok/s** | **+32.8% faster** |
| **Slot Concurrency** | 1 sequential slot | **4 parallel slots** | **4x throughput** |
| **First Token Latency** | ~450ms | **~120ms** | **3.75x lower** |

---

## 📁 Repository Structure

```text
├── setup_wizard.py               # Cross-platform guided installer wizard
├── install.sh                    # POSIX bootstrap launcher (macOS & Linux)
├── install.bat / install.ps1     # Windows bootstrap launchers (CMD & PowerShell)
├── pi_extensions/
│   └── lfm3_agent_extension.ts   # Pi Coding Agent custom optimization extension
├── launchers/
│   ├── start_llama_server.sh/bat # Optimized llama-server launcher
│   ├── start_ollama.sh/bat       # Ollama service launcher
│   └── pi_lfm3.sh/bat            # Pre-configured Pi launch wrapper
├── llama_cpp_client.py           # AutoThinkingPolicy & high-performance GGUF client
├── repo_indexer.py               # AST docstring stripper & dependency slicer
├── run_full_battery_eval.py      # 15-task full test battery runner
├── run_llama_cpp_repo_benchmark.py # Production requests repository benchmark
└── run_swe_bench_mini.py         # Multi-repo SWE-Bench Lite evaluation
```

---

## License
MIT
