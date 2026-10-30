import textwrap

import pytest

import benchmark_tasks
from benchmark_tasks import SWE_BENCH_INSTANCES, TASKS, control_failures, scout_schema
from llama_cpp_client import syntax_error
from repo_benchmark import reindent, strip_inner_imports
from repo_indexer import RepoASTIndexer
from run_full_battery_eval import snippet_window

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


def test_snippet_window_dedents_and_drops_comments():
    assert snippet_window("\n        # note\n        if a:\n            b\n") == "if a:\n    b"


def test_swe_snippets_parse():
    for inst in SWE_BENCH_INSTANCES:
        assert syntax_error(snippet_window(inst["code_context"])) is None, inst["instance_id"]


@pytest.fixture
def fake_repo(monkeypatch):
    """Stubs the repo helpers. `state` holds whether the defect is injected; `checks` maps that state to the check result."""
    repo = type("Repo", (), {"injected": False, "checks": {False: True, True: False}})
    monkeypatch.setattr(benchmark_tasks, "reset_repo", lambda: setattr(repo, "injected", False))
    monkeypatch.setattr(benchmark_tasks, "inject_defect", lambda task: setattr(repo, "injected", True))
    monkeypatch.setattr(benchmark_tasks, "verify", lambda task: (repo.checks[repo.injected], "No module named pytest"))
    return repo


def test_control_failures_accepts_working_checks(fake_repo):
    assert control_failures(TASKS) == []


def test_control_failures_reports_broken_environment(fake_repo):
    fake_repo.checks = {False: False, True: False}
    failures = control_failures(TASKS[:1])
    assert failures == ["TASK-1: check fails on the clean repo: No module named pytest"]


def test_control_failures_reports_check_blind_to_defect(fake_repo):
    fake_repo.checks = {False: True, True: True}
    assert control_failures(TASKS[:1]) == ["TASK-1: check passes with the defect injected"]


def test_scout_schema_limits_answers_to_candidates():
    schema = scout_schema([{"file": "a.py", "function": "f"}, {"file": "b.py", "function": "g"}, {"file": "a.py", "function": "g"}])
    assert schema["properties"]["target_file"]["enum"] == ["a.py", "b.py"]
    assert schema["properties"]["target_function"]["enum"] == ["f", "g"]
    assert schema["required"] == ["target_file", "target_function"]


def test_task_data_is_complete():
    for task in TASKS:
        assert task["original"] != task["defect"] and task["function"] and task["check"]
    for inst in SWE_BENCH_INSTANCES:
        assert inst["ground_truth_fix_keyword"] not in inst["code_context"]
