"""AST helpers for locating and slicing functions in a repository without spending model tokens."""

import ast
import os
import re
import textwrap
from typing import Any, Dict, List, Tuple


def words(text: str) -> set:
    return {w.lower() for w in re.split(r"[\s_.]+", text) if len(w) > 2}


class RepoASTIndexer:
    def __init__(self, repo_root: str):
        self.repo_root = os.path.abspath(repo_root)

    def _parse(self, rel_path: str) -> Tuple[List[str], ast.Module]:
        with open(os.path.join(self.repo_root, rel_path), encoding="utf-8") as fp:
            source = fp.read()
        return source.splitlines(True), ast.parse(source)

    @staticmethod
    def _find_function(tree: ast.AST, name: str) -> ast.AST:
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
                return node
        raise ValueError(f"Function {name} not found")

    def scan_symbols(self) -> List[Dict[str, Any]]:
        """Lists every function and class in the repository with its file, line span, and docstring."""
        symbols = []
        for root, _, files in os.walk(self.repo_root):
            for f in files:
                if not f.endswith(".py"):
                    continue
                rel_path = os.path.relpath(os.path.join(root, f), self.repo_root)
                try:
                    _, tree = self._parse(rel_path)
                except (SyntaxError, UnicodeDecodeError):
                    continue
                symbols.extend(
                    {
                        "name": node.name,
                        "file": rel_path,
                        "start_line": node.lineno,
                        "end_line": node.end_lineno,
                        "docstring": ast.get_docstring(node) or "",
                    }
                    for node in ast.walk(tree)
                    if isinstance(node, (ast.FunctionDef, ast.ClassDef))
                )
        return symbols

    def get_module_imports(self, rel_path: str) -> List[str]:
        _, tree = self._parse(rel_path)
        return [ast.unparse(n) for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom))]

    def get_clean_function_context(self, rel_path: str, function_name: str) -> Dict[str, Any]:
        """Returns the dedented function without its docstring, plus its signature line, base indent, and line span."""
        lines, tree = self._parse(rel_path)
        node = self._find_function(tree, function_name)
        raw = lines[node.lineno - 1:node.end_lineno]
        dedented = textwrap.dedent("".join(raw))

        parsed = ast.parse(dedented).body[0]
        if ast.get_docstring(parsed) and len(parsed.body) > 1:
            doc = parsed.body[0]
            d_lines = dedented.splitlines(True)
            dedented = "".join(d_lines[:doc.lineno - 1] + d_lines[doc.end_lineno:])

        return {
            "clean_code": dedented.strip(),
            "signature": dedented.strip().splitlines()[0],
            "base_indent": len(raw[0]) - len(raw[0].lstrip()),
            "start_line": node.lineno,
            "end_line": node.end_lineno,
        }

    def get_adaptive_source_slice(self, rel_path: str, function_name: str, issue: str, max_lines=35) -> Tuple[str, int, int]:
        """
        Returns (source, start_line, end_line) of at most max_lines from the function.
        Longer functions are narrowed to the loop/branch/try/with block sharing the most words with `issue`.
        """
        lines, tree = self._parse(rel_path)
        fn = self._find_function(tree, function_name)
        start, end = fn.lineno, fn.end_lineno
        if end - start + 1 <= max_lines:
            return "".join(lines[start - 1:end]), start, end

        query = words(issue)
        blocks = [
            (len(query & words("".join(lines[c.lineno - 1:c.end_lineno]))), c.lineno, c.end_lineno)
            for c in ast.walk(fn)
            if c is not fn and isinstance(c, (ast.While, ast.For, ast.If, ast.Try, ast.With))
        ]
        blocks.sort(key=lambda b: (b[0], b[1] - b[2]), reverse=True)

        if blocks and blocks[0][0] > 0:
            _, b_start, b_end = blocks[0]
            if b_end - b_start + 1 <= max_lines:
                start = b_start - min(6, b_start - start, max_lines - (b_end - b_start + 1))
                end = min(end, start + max_lines)
            else:
                start = max(start, b_end - max_lines)
                end = b_end
        else:
            end = min(end, start + max_lines)
        return "".join(lines[start - 1:end]), start, end
