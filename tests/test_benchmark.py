import textwrap

import pytest

from benchmark_tasks import SWE_BENCH_INSTANCES, TASKS
from repo_benchmark import reindent, strip_inner_imports
from repo_indexer import RepoASTIndexer
from run_full_battery_eval import snippet_parses

MODULE = textwrap.dedent('''
    import os
    from sys import path


    class Session:
        def resolve(self, url):
            """Resolve a URL.

            Long docstring.
            """
            if url:
                return url
            return None
''')


@pytest.fixture
def indexer(tmp_path):
    (tmp_path / "mod.py").write_text(MODULE)
    (tmp_path / "broken.py").write_text("def (")
    return RepoASTIndexer(tmp_path)


def test_scan_symbols_skips_unparseable_files(indexer):
    assert {(s["file"], s["name"]) for s in indexer.scan_symbols()} == {("mod.py", "Session"), ("mod.py", "resolve")}


def test_module_imports(indexer):
    assert indexer.get_module_imports("mod.py") == ["import os", "from sys import path"]


def test_clean_function_context_strips_docstring(indexer):
    ctx = indexer.get_clean_function_context("mod.py", "resolve")
    assert ctx["signature"] == "def resolve(self, url):"
    assert ctx["base_indent"] == 4
    assert '"""' not in ctx["clean_code"]
    assert (ctx["start_line"], ctx["end_line"]) == (7, 14)


def test_adaptive_slice_narrows_long_functions(indexer):
    whole = indexer.get_adaptive_source_slice("mod.py", "resolve", "url", max_lines=35)
    assert whole[1:] == (7, 14)
    narrowed = indexer.get_adaptive_source_slice("mod.py", "resolve", "url", max_lines=3)
    assert "if url:" in narrowed[0] and "return url" in narrowed[0]


def test_missing_function_raises(indexer):
    with pytest.raises(ValueError):
        indexer.get_clean_function_context("mod.py", "missing")


def test_reindent_keeps_relative_indentation():
    assert reindent("def f():\n  if x:\n    return 1\n# note", 4) == "    def f():\n      if x:\n        return 1\n    # note\n"


def test_strip_inner_imports():
    assert strip_inner_imports("def f():\n    import os\n    return 1") == "def f():\n    return 1"
    assert strip_inner_imports("import os\nx = 1") == "import os\nx = 1"
    assert strip_inner_imports("def (") == "def ("


def test_snippet_parses():
    assert snippet_parses("return x")
    assert snippet_parses("    y = 1")
    assert not snippet_parses("def (")


def test_task_data_is_complete():
    for task in TASKS:
        assert task["original"] != task["defect"] and task["function"] and task["check"]
    for inst in SWE_BENCH_INSTANCES:
        assert inst["ground_truth_fix_keyword"] not in inst["code_context"]
