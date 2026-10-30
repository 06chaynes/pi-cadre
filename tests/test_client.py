import pytest

from llama_cpp_client import AutoModelPolicy, AutoThinkingPolicy, LlamaCppClient, extract_code, syntax_error


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


def test_extract_code_reads_unclosed_fence():
    assert extract_code("```python\nx = 1\n") == "x = 1"


def test_extract_code_skips_thinking():
    assert extract_code("plan\n```python\nwrong = 1\n```\n</think>\n```python\nx = 1\n```") == "x = 1"


def test_syntax_error():
    assert syntax_error("    return x") is None
    assert syntax_error("x = 1\ny = 2") is None
    assert syntax_error("def (") is not None
    assert syntax_error("    a = 1\n    b = = 2\n    c = 3").lineno == 2


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
        if path == "/apply-template":
            return {"content": "<template>", "tokens": 0}
        reply = posts.replies.pop(0) if posts.replies else posts.reply
        return {"content": reply, "tokens": 1} if isinstance(reply, str) else {"tokens": 1, **reply}

    posts = type("Posts", (), {"calls": calls, "reply": "", "replies": []})
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


def test_generate_code_spark_template(posts):
    posts.reply = "```python\nx = 2\n```"
    code, _ = LlamaCppClient().generate_code("spark", "sys", "user", "Fix it.", think=True)
    (model, path, template), (_, completion_path, payload) = posts.calls
    assert (model, path, completion_path) == ("spark", "/apply-template", "/completion")
    assert template["messages"][1]["content"] == "user\n\nFix it."
    assert template["chat_template_kwargs"] == {"enable_thinking": True}
    assert payload["prompt"] == "<template>"
    assert code == "x = 2"


def test_generate_code_backtracks_to_parseable_alternative(posts):
    tokens = ["```python\n", "if (\n", "    a\n", "    and f(b", "):", "\n", "):\n", "    pass\n", "```"]
    probs = [{"token": t, "top_logprobs": [{"token": t, "logprob": 0.0}]} for t in tokens]
    probs[4]["top_logprobs"].append({"token": ")", "logprob": -4.5})
    posts.replies = [{"content": "".join(tokens), "probs": probs}, {"content": "\n):\n    pass\n```", "probs": []}]
    code, res = LlamaCppClient().generate_code("spark", "sys", "user", "Fix it.")
    assert posts.calls[-1][2]["prompt"] == "<template>```python\nif (\n    a\n    and f(b)"
    assert code == "if (\n    a\n    and f(b)\n):\n    pass"
    assert res["repaired"]


def test_generate_code_keeps_output_without_parseable_alternative(posts):
    posts.reply = "```python\ndef (\n```"
    code, res = LlamaCppClient().generate_code("spark", "sys", "user", "Fix it.")
    assert code == "def (" and not res["repaired"]
    assert len(posts.calls) == 2


def test_chat_json_names_required_fields(posts):
    posts.reply = '{"a": 1}'
    messages = [{"role": "user", "content": "Pick one."}]
    schema = {"type": "object", "properties": {"a": {"type": "integer"}, "b": {"type": "string"}}, "required": ["a", "b"]}
    assert LlamaCppClient(model_mode="spark").chat_json(messages, schema) == {"a": 1}
    sent = posts.calls[0][2]["messages"]
    assert sent[-1]["content"] == "Pick one.\n\nRespond with a JSON object containing exactly these fields: a, b."
    assert messages[0]["content"] == "Pick one."


def test_chat_json_routes_by_intent(posts, monkeypatch):
    monkeypatch.setattr(LlamaCppClient, "check_health", staticmethod(lambda model: True))
    LlamaCppClient().chat_json([{"role": "user", "content": "x"}], {"type": "object", "properties": {}}, task_intent="scout")
    assert posts.calls[0][0] == "lfm3"
