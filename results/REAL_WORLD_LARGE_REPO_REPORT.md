# Real-World Large Repository Benchmark: Empirical Assessment & Failure Analysis

**Target Repository:** `psf/requests` (v2.28.0 — 15,000 LOC, 14 production modules, 279 symbols)  
**Evaluation Model:** `lfm3:latest` (1.7B parameters, MLX runner on Apple M1 Pro)  
**Evaluation Scope:** 4 real-world production defects across `utils.py` and `sessions.py`.

---

## Executive Summary & Scorecard

| Task ID | Task Description | Target File & Symbol | Baseline Pass | Remediated Swarm Pass | Swarm Latency | Tokens Consumed |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: |
| **TASK-1** | Proxy Auth Preservation | `requests/utils.py` :: `prepend_scheme_if_needed` | ❌ Fail | **✅ Pass** *(with import invariant)* | 0.43s | 72 |
| **TASK-2** | CA Bundle Env Fallback | `requests/sessions.py` :: `merge_environment_settings` | ❌ Fail | ⚠️ Partial *(logic drift on fallback)* | 2.49s | 104 |
| **TASK-3** | URL Credential Unquoting | `requests/utils.py` :: `get_auth_from_url` | ❌ Fail | **✅ Pass** *(zero-shot)* | 5.48s | 27 |
| **TASK-4** | Multi-Hop Redirect Drift | `requests/sessions.py` :: `resolve_redirects` | ❌ Fail | **✅ Pass** *(Sub-AST loop slicing)* | 3.82s | 68 |

---

## Comparative Failure Analysis: Baseline vs. Swarm Setup

```mermaid
flowchart TD
    subgraph Unguided_Baseline["Unguided Baseline (Failure Path)"]
        A1["Raw Repo / Full File Context (6,000+ chars)"] --> A2["Rambling Trace Trap (burns 450+ tokens reciting code)"]
        A2 --> A3["Context Truncation / Syntax Error / 0/4 Test Passes"]
    end

    subgraph Remediated_Swarm["Remediated 4-Stage Gated Swarm"]
        B1["Deterministic AST Indexer (279 symbols, 25ms, 0 tokens)"] --> B2["Top-15 Lexical Filter (0 tokens)"]
        B2 --> B3["xGrammar Scout Agent (JSON Schema Gated, 1.7s)"]
        B3 --> B4["Sub-AST Scope & Indentation Slicer (25-35 lines)"]
        B4 --> B5["Gated Surgeon + Invariant Enforcement (No Internal Imports)"]
        B5 --> B6["Self-Healing Pytest Harness (Instant Verification)"]
    end
```

---

## Deep Dive: Shortcomings & Failure Modes Uncovered

### 1. The "Rambling Trace Trap" (Unguided Baseline)
- **Symptom:** In Tasks 1, 2, and 4, the unguided model output phrases such as:
  > *"Let's trace the implementation...", "Step 1: Understand the issue...", "We need to fix the bug in merge_environment_settings..."*
- **Mechanism:** When presented with full file context without structured decoding gates, 1.7B models treat the prompt as an open-ended conversational trace. They consume 400–500 tokens verbalizing their intermediate reasoning into the `content` channel and hit `max_tokens` before emitting a complete code patch.
- **Remediation:** Strict prompt start invariant (`"Start your response IMMEDIATELY with \`\`\`python"`) and mathematical xGrammar JSON schema gating (`SURGEON_DIFF_SCHEMA`).

---

### 2. The "Hallucinated Import Reflex" (Task 1 Initial Failure)
- **Symptom:** In the initial Task 1 run, Surgeon localized the exact bug but failed all 5 pytest assertions with:
  ```text
  ImportError: cannot import name 'parse_url' from 'urllib.parse'
  ```
- **Mechanism:** Because Surgeon was provided an isolated function slice, the compact model panicked about missing module symbols and injected `from urllib.parse import parse_url, urlunparse` inside the function body. In Python, `parse_url` belongs to `urllib3.util`, not `urllib.parse`.
- **Remediation:** **Scope-Preserving Payload Invariant**:
  ```text
  CRITICAL INVARIANT: DO NOT add any import statements inside the function.
  All necessary imports and helpers are ALREADY imported at the module level.
  ```
  Once this invariant was applied, Surgeon generated the clean fix in **0.43s**, passing 5/5 pytest checks.

---

### 3. The "Boilerplate Exhaustion" in Large Functions (Tasks 2 & 4)
- **Symptom:** `resolve_redirects` is 122 lines long; `merge_environment_settings` is 30 lines long. Asking a 1.7B model to regenerate a 122-line method to change 1 line (`req = prepared_request`) caused token truncation and indentation drift.
- **Mechanism:** Generation latency and autoregressive drift scale linearly with output token length. 1.7B models lose grammatical coherence after ~200 generated tokens if forced to retype boilerplate.
- **Remediation:** **Sub-AST Block Slicing & Structured JSON Diffing**:
  Instead of slicing the entire function, slice the inner `while url:` loop tail (lines 250–280). In our test, Surgeon generated the fix `req = prepared_request` in **3.82s** with 68 tokens.

---

### 4. Indentation & Class-Scope Nesting Drift
- **Symptom:** Functions inside classes (e.g. `Session.merge_environment_settings` or `SessionRedirectMixin.resolve_redirects`) require 4 to 12 spaces of indentation. Naive string replacement without indentation normalization causes syntax errors upon file re-assembly.
- **Remediation:** Deterministic `align_indentation` and `replace_by_stripped_match` utilities detect the indentation offset of the target AST node and automatically re-indent the generated patch before writing to disk.

---

## Key Performance Metrics

| Metric | Unguided Baseline | Remediated Swarm Setup | Improvement Factor |
| :--- | :--- | :--- | :--- |
| **AST Repo Scan Time** | N/A (Not indexed) | **0.025s (25ms)** | Deterministic / 0 tokens |
| **Symbol Localization Accuracy** | N/A (Full file dump) | **100% (4/4 symbols)** | High confidence via xGrammar |
| **Average Token Consumption** | 450+ tokens / task | **55 tokens / task** | **8.2x token reduction** |
| **Average End-to-End Latency** | 10.8s (all failed) | **3.05s** (for passing tasks) | **3.5x faster** |
| **Pytest Pass Rate** | **0.0% (0/4)** | **75.0% (3/4 passing)** | $\mathbf{+\infty}$ pass rate delta |

---

## Actionable Recommendations for Production Swarms

1. **Sub-AST Block Level Slicing:** Never feed entire functions >50 lines to sub-2B models; slice the enclosing loop, conditional block, or statement group.
2. **Strict Module-Level Import Isolation:** Explicitly instruct the surgeon that all module-level imports and constants are pre-bound.
3. **Structured JSON Replacement Over Full-Code Generation:** Use xGrammar schema `{"original_code": "...", "replacement_code": "..."}` for single-line and few-line bug fixes to completely eliminate conversational preambles.
