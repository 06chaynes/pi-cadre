import pytest

from llama_cpp_client import AutoModelPolicy, AutoThinkingPolicy, LlamaCppClient, extract_code


@pytest.mark.parametrize("intent, schema, retry, prompt, expected", [
    ("synthesis", False, False, "def add(a, b): return a + b", False),
    ("completion", False, False, "url = parse_url(x)", False),
    ("schema", True, False, "Output JSON", False),
    ("diagnosis", False, False, "Analyze root cause of memory leak", True),
    ("planning", False, False, "Plan multi-step migration", True),
    ("synthesis", False, True, "AssertionError: assert 1 == 2", True),
    ("synthesis", False, True, "no signal here", False),
])
def test_thinking_auto(intent, schema, retry, prompt, expected):
    assert AutoThinkingPolicy.resolve("auto", intent, schema, retry, prompt) is expected


def test_thinking_forced():
    assert AutoThinkingPolicy.resolve("on", "code") is True
    assert AutoThinkingPolicy.resolve("off", "diagnosis") is False


@pytest.mark.parametrize("mode, intent, ctx, expected", [
    ("auto", "micro_patch", 2048, "lfm3"),
    ("auto", "scout", 2048, "lfm3"),
    ("auto", "architecture", 65536, "spark"),
    ("auto", "diagnosis", 32768, "spark"),
    ("auto", "scout", 524288, "spark"),
    ("spark", "micro_patch", 2048, "spark"),
    ("lfm3", "architecture", 65536, "lfm3"),
])
def test_model_policy(mode, intent, ctx, expected):
    assert AutoModelPolicy.resolve(mode, intent, ctx) == expected


def test_extract_code():
    assert extract_code("text\n```python\nx = 1\n```\nmore") == "x = 1"
    assert extract_code("  x = 1  ") == "x = 1"


def test_resolve_model_falls_back_only_in_auto(monkeypatch):
    monkeypatch.setattr(LlamaCppClient, "check_health", staticmethod(lambda model: model == "spark"))
    assert LlamaCppClient(model_mode="auto").resolve_model("micro_patch") == "spark"
    assert LlamaCppClient(model_mode="lfm3").resolve_model("micro_patch") == "lfm3"


@pytest.fixture
def posts(monkeypatch):
    """Replaces HTTP calls with a stub that records (model, path, payload) and returns `reply`."""
    calls = []

    def fake_post(self, model, path, payload, parse):
        calls.append((model, path, payload))
        return {"content": posts.reply, "tokens": 1}

    posts = type("Posts", (), {"calls": calls, "reply": ""})
    monkeypatch.setattr(LlamaCppClient, "_post", fake_post)
    return posts


def test_generate_code_lfm3_prefill(posts):
    posts.reply = "\n    return x + 1"
    code, _ = LlamaCppClient().generate_code("lfm3", "sys", "user", "unused", prefill="def f(x):")
    model, path, payload = posts.calls[0]
    assert (model, path) == ("lfm3", "/completion")
    assert payload["prompt"].endswith("<|im_start|>assistant\n```python\ndef f(x):")
    assert code == "def f(x):\n    return x + 1"


def test_generate_code_lfm3_think(posts):
    posts.reply = "reasoning</think>\n```python\n    return x + 1\n```"
    code, _ = LlamaCppClient().generate_code("lfm3", "sys", "user", "unused", prefill="def f(x):", think=True, max_tokens=100)
    payload = posts.calls[0][2]
    assert payload["prompt"].endswith("<think>\n") and payload["n_predict"] == 200
    assert code == "def f(x):\nreturn x + 1"


def test_generate_code_spark_chat(posts):
    posts.reply = "```python\nx = 2\n```"
    code, _ = LlamaCppClient().generate_code("spark", "sys", "user", "Fix it.", think=True)
    model, path, payload = posts.calls[0]
    assert (model, path) == ("spark", "/v1/chat/completions")
    assert payload["messages"][1]["content"] == "user\n\nFix it."
    assert payload["chat_template_kwargs"] == {"enable_thinking": True}
    assert code == "x = 2"
