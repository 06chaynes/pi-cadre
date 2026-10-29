"""
Stage 1 & 2 Engine: Deterministic Traceback Slicer + AST Symbol Graph Indexer.
Extracts failing frames from pytest runs and builds a symbol map of all functions,
classes, and docstrings across the entire repository.
Cost: 0 LLM Tokens!
"""

import os
import ast
import subprocess
import sys
from typing import Dict, Any, List, Optional, Tuple

class RepoASTIndexer:
    def __init__(self, repo_root: str):
        self.repo_root = os.path.abspath(repo_root)

    def scan_symbols(self) -> List[Dict[str, Any]]:
        symbols = []
        for root, _, files in os.walk(self.repo_root):
            for f in files:
                if f.endswith(".py"):
                    full_path = os.path.join(root, f)
                    rel_path = os.path.relpath(full_path, self.repo_root)
                    try:
                        with open(full_path, "r", encoding="utf-8") as fp:
                            content = fp.read()
                            tree = ast.parse(content, filename=rel_path)

                        for node in ast.walk(tree):
                            if isinstance(node, ast.FunctionDef):
                                symbols.append({
                                    "type": "function",
                                    "name": node.name,
                                    "file": rel_path,
                                    "start_line": node.lineno,
                                    "end_line": getattr(node, "end_lineno", node.lineno + 25),
                                    "docstring": ast.get_docstring(node) or ""
                                })
                            elif isinstance(node, ast.ClassDef):
                                symbols.append({
                                    "type": "class",
                                    "name": node.name,
                                    "file": rel_path,
                                    "start_line": node.lineno,
                                    "end_line": getattr(node, "end_lineno", node.lineno + 30),
                                    "docstring": ast.get_docstring(node) or ""
                                })
                    except Exception:
                        pass
        return symbols

    def run_reproducer_and_slice(self, test_script: str) -> Optional[Dict[str, Any]]:
        """
        Runs the test script and automatically slices the bottom-most stack frame.
        """
        env = dict(os.environ)
        env["PYTHONPATH"] = self.repo_root
        res = subprocess.run(
            [sys.executable, test_script],
            capture_output=True,
            text=True,
            env=env
        )

        if res.returncode == 0:
            return None # Passed, no bug found

        stderr = res.stderr or res.stdout
        lines = stderr.splitlines()

        # Find the last stack frame inside the repo
        target_file = None
        target_line = None
        for l in reversed(lines):
            if 'File "' in l and self.repo_root in l:
                # e.g. File ".../separable.py", line 15, in ...
                parts = l.strip().split('"')
                if len(parts) >= 2:
                    target_file = os.path.relpath(parts[1], self.repo_root)
                    if "line " in l:
                        target_line = int(l.split("line ")[1].split(",")[0].strip())
                    break

        return {
            "exit_code": res.returncode,
            "error_tail": "\n".join(lines[-4:]),
            "target_file": target_file,
            "target_line": target_line
        }

    def get_source_slice(self, rel_path: str, start_line: int, end_line: int) -> str:
        full_path = os.path.join(self.repo_root, rel_path)
        with open(full_path, "r", encoding="utf-8") as fp:
            lines = fp.readlines()
        
        # Zero-indexed slice
        start_idx = max(0, start_line - 1)
        end_idx = min(len(lines), end_line)
        return "".join(lines[start_idx:end_idx])

    def get_adaptive_source_slice(
        self,
        rel_path: str,
        function_name: str,
        issue_description: str,
        max_lines: int = 35
    ) -> Tuple[str, int, int, bool]:
        """
        Adaptive AST Slicer.
        If function <= max_lines, returns entire function.
        If function > max_lines, searches child AST blocks (While, For, If, Try, With)
        and scores them against issue keywords, returning the top focused window.
        """
        import re
        full_path = os.path.join(self.repo_root, rel_path)
        with open(full_path, "r", encoding="utf-8") as fp:
            code_lines = fp.readlines()
        full_content = "".join(code_lines)
        tree = ast.parse(full_content)

        target_node = None
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == function_name:
                target_node = node
                break

        if not target_node:
            return "".join(code_lines[:max_lines]), 1, min(len(code_lines), max_lines), False

        fn_start = target_node.lineno
        fn_end = getattr(target_node, "end_lineno", fn_start + 25)
        total_lines = fn_end - fn_start + 1

        if total_lines <= max_lines:
            return "".join(code_lines[fn_start - 1 : fn_end]), fn_start, fn_end, False

        # Function exceeds max_lines -> traverse child blocks
        query_words = set(w.lower() for w in re.split(r"[\s_.]+", issue_description) if len(w) > 2)
        candidates = []

        for child in ast.walk(target_node):
            if child is target_node:
                continue
            if isinstance(child, (ast.While, ast.For, ast.If, ast.Try, ast.With)):
                c_start = child.lineno
                c_end = getattr(child, "end_lineno", c_start + 5)
                block_lines = code_lines[c_start - 1 : c_end]
                block_text = "".join(block_lines)
                block_words = set(w.lower() for w in re.split(r"[\s_.]+", block_text) if len(w) > 2)
                score = len(query_words.intersection(block_words))
                candidates.append((score, c_start, c_end, c_end - c_start + 1))

        candidates.sort(key=lambda x: (x[0], -x[3]), reverse=True)

        if candidates and candidates[0][0] > 0:
            _, best_s, best_e, span = candidates[0]
            if span <= max_lines:
                lead = min(6, best_s - fn_start)
                win_start = best_s - lead
                win_end = min(fn_end, win_start + max_lines)
            else:
                win_start = max(fn_start, best_e - max_lines)
                win_end = best_e
        else:
            win_start = fn_start
            win_end = min(fn_end, win_start + max_lines)

        slice_text = "".join(code_lines[win_start - 1 : win_end])
        return slice_text, win_start, win_end, True
