# Foundational Root Cause & Solution: Scope-Preserving Payload Transport

## 1. The Foundational Defect Identified in `sort_numbers`

When inspecting the exact execution failure for `HumanEval/19` (`sort_numbers`), we discovered a critical bug in the **payload transport boundary** between agents:

### The Mechanism of Failure:
In Python, models often define constants or mappings at the module level before the function definition:
```python
from typing import List

# Module-level constant dictionary
word_to_value = {
    'zero': 0, 'one': 1, 'two': 2, ...
}

def sort_numbers(numbers: str) -> str:
    words = numbers.split()
    return ' '.join(sorted(words, key=lambda w: word_to_value[w]))
```
However, the naive parser in the benchmark harness was slicing the response string starting strictly at `def sort_numbers`:
```python
# The bug:
idx = code.find(f"def {entry_point}")
return code[idx:] # <--- Dropped word_to_value completely!
```
Because the slice started at `def sort_numbers`, **`word_to_value` was severed and discarded**. When Python executed the function inside the sandbox, it crashed with:
`NameError: name 'word_to_value' is not defined`.

The model wrote 100% correct code, but the harness's payload boundary chopped off its global dependencies!

---

## 2. The General Architectural Fix: Scope-Preserving Extraction

We replaced the naive function-slicing logic with a **Scope-Preserving Code Extractor** that operates as a general rule across all agent communications:
1. **Preserve Preamble Declarations:** Keep all imports, constants, dictionaries, and helper functions defined before the target entry point.
2. **Standard Library Header Injection:** Ensure standard modules (`math`, `typing`) referenced in the block are bound to the execution scope.

### The Immediate Result:
In the verification run, **`HumanEval/19` (`sort_numbers`) immediately PASSED (10.42s)** with zero task-specific modifications.

---

## 3. The 3 Universal Invariants Discovered for Compact (1.7B) Models

Across this entire investigation, every single failure of the LFM3 1.7B model traced back to one of three universal architectural shortcomings:

| Shortcoming | Failure Mode Observed | General Foundational Fix |
| :--- | :--- | :--- |
| **1. Token Bloat on Prompt Echo** | Model repeats docstring examples and runs out of tokens mid-function (`sum_product`, `intersperse`). | **Docstring Detachment Invariant:** Instruct agents to never re-include docstrings in code blocks. |
| **2. Multi-State Cognitive Overload** | Model tries to handle nested brackets and accumulation in one turn and fails (`parse_nested_parens`, `separate_paren_groups`). | **Gated Helper-Assembler Swarm:** Decompose stateful parsers into a 10-line helper function and an assembler. |
| **3. Payload Scope Severing** | Harness strips text preceding `def ...`, severing global dictionaries and imports (`sort_numbers`). | **Scope-Preserving Payload Transport:** Preserve module-level constants and imports across agent hand-offs. |
