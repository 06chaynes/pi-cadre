import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import extension, { guardReason, modelConfigs } from "./cadre.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stubs fetch so /props on the given ports reports n_ctx, and every other request fails. */
function serveProps(contexts: Record<number, number>) {
  globalThis.fetch = (async (url: string) => {
    const port = Number(new URL(url).port);
    if (url.endsWith("/props") && port in contexts) {
      return new Response(JSON.stringify({ default_generation_settings: { n_ctx: contexts[port] } }));
    }
    throw new Error("connection refused");
  }) as typeof fetch;
}

/** Minimal ExtensionAPI stand-in that records registrations and thinking changes. */
function fakePi() {
  const calls = {
    providers: {} as Record<string, any>,
    commands: {} as Record<string, any>,
    handlers: {} as Record<string, Function>,
    thinking: [] as string[],
  };
  const pi = {
    registerProvider: (name: string, config: unknown) => (calls.providers[name] = config),
    registerCommand: (name: string, command: unknown) => (calls.commands[name] = command),
    on: (event: string, handler: Function) => (calls.handlers[event] = handler),
    setThinkingLevel: (level: string) => calls.thinking.push(level),
  };
  return { pi, calls };
}

test("models use the detected per-slot context", () => {
  const [spark, lfm3] = modelConfigs({ spark: 32768, lfm3: 2048 });
  assert.equal(spark.baseUrl, "http://127.0.0.1:8080/v1");
  assert.equal(spark.contextWindow, 32768);
  assert.equal(spark.maxTokens, 8192);
  assert.equal(lfm3.baseUrl, "http://127.0.0.1:8081/v1");
  assert.equal(lfm3.contextWindow, 2048);
  assert.equal(lfm3.maxTokens, 512);
});

test("models fall back to the launcher defaults when a server is offline", () => {
  const [spark, lfm3] = modelConfigs({});
  assert.equal(spark.contextWindow, 32768);
  assert.equal(lfm3.contextWindow, 2048);
});

test("thinking is sent as chat template kwargs each template accepts", () => {
  const [spark, lfm3] = modelConfigs({});
  assert.deepEqual(spark.compat, {
    thinkingFormat: "chat-template",
    chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" }, reasoning_effort: { $var: "thinking.effort" } },
  });
  assert.deepEqual(spark.thinkingLevelMap, { minimal: "low", low: "low", medium: "high", high: "high" });
  assert.deepEqual(lfm3.compat, {
    thinkingFormat: "chat-template",
    chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
  });
});

test("the factory registers the llama-cpp provider from live servers", async () => {
  serveProps({ 8080: 131072 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  const provider = calls.providers["llama-cpp"];
  assert.equal(provider.api, "openai-completions");
  assert.equal(provider.apiKey, "none");
  assert.deepEqual(provider.models.map((m: any) => m.contextWindow), [131072, 2048]);
});

test("auto thinking turns on for review and diagnosis prompts only", async () => {
  serveProps({});
  const { pi, calls } = fakePi();
  await extension(pi as any);
  for (const prompt of ["Review store.py for edge cases", "Diagnose the root cause", "Add a restock_report method"]) {
    await calls.handlers["before_agent_start"]({ prompt });
  }
  assert.deepEqual(calls.thinking, ["medium", "medium", "off"]);
});

const HOME = "/home/u";
const CWD = "/home/u/proj";
const guard = (toolName: string, input: Record<string, unknown>) => guardReason(toolName, input, CWD, HOME);

test("the guard blocks the commands an agent ran outside its project", () => {
  for (const command of [
    "cd /home/u/Documents/lfm-test && ls",
    'grep -rln "commit_ships" /home/u --include=*.py',
    "find / -name test_store.py 2>/dev/null",
    "ls ~/.ssh",
    "cat $HOME/.npmrc",
    "cat ${HOME}/.npmrc",
    "ls ../other",
  ]) {
    assert.ok(guard("bash", { command }), command);
  }
});

test("the guard allows project, system, and plain commands", () => {
  for (const command of [
    "python3 -m pytest -q",
    "cd /home/u/proj/tests && ls",
    "ls sub/dir ./x",
    "cat /etc/hosts /usr/lib/os-release",
    "curl -s http://127.0.0.1:8080/health",
    "git diff -- a/b",
  ]) {
    assert.equal(guard("bash", { command }), undefined, command);
  }
});

test("writes and edits must stay inside the project", () => {
  assert.equal(guard("write", { path: "src/a.py" }), undefined);
  assert.equal(guard("edit", { path: "/home/u/proj/a.py" }), undefined);
  assert.ok(guard("write", { path: "/tmp/a.py" }));
  assert.ok(guard("edit", { path: "../other/a.py" }));
});

test("reads and searches may use system paths but not the rest of home", () => {
  assert.equal(guard("read", { path: "/etc/hosts" }), undefined);
  assert.equal(guard("ls", {}), undefined);
  assert.equal(guard("grep", { pattern: "x", path: "tests" }), undefined);
  assert.ok(guard("read", { path: "/home/u/.ssh/id_ed25519" }));
  assert.ok(guard("find", { pattern: "*.py", path: "/" }));
});

test("the tool_call hook blocks until /cadre-guard off", async () => {
  serveProps({});
  const { pi, calls } = fakePi();
  await extension(pi as any);
  const ctx = { cwd: process.cwd(), ui: { notify: () => {} } };
  const call = { toolName: "bash", input: { command: "find / -name x" } };
  const blocked = await calls.handlers["tool_call"](call, ctx);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /outside the project/);
  await calls.commands["cadre-guard"].handler("off", ctx);
  assert.equal(await calls.handlers["tool_call"](call, ctx), undefined);
});

test("the guard follows symlinks before deciding", async () => {
  const { mkdtempSync, mkdirSync, symlinkSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const home = mkdtempSync(join(tmpdir(), "cadre-home-"));
  const cwd = join(home, "proj");
  mkdirSync(cwd);
  mkdirSync(join(home, "other"));
  symlinkSync(join(home, "other"), join(cwd, "linked"));
  assert.ok(guardReason("write", { path: "linked/new.py" }, cwd, home));
  assert.ok(guardReason("read", { path: "linked" }, cwd, home));
  assert.ok(guardReason("bash", { command: "cat linked/notes.txt" }, cwd, home));
  assert.equal(guardReason("write", { path: "new/dir/file.py" }, cwd, home), undefined);
});

test("the guard resolves dangling links and '..' after a link the way the OS does", async () => {
  const { mkdtempSync, mkdirSync, symlinkSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const home = mkdtempSync(join(tmpdir(), "cadre-home-"));
  const cwd = join(home, "proj");
  mkdirSync(join(cwd, "sub"), { recursive: true });
  mkdirSync(join(home, "other", "deep"), { recursive: true });
  symlinkSync(join(home, "missing", "target.py"), join(cwd, "dangling.py"));
  symlinkSync(join(home, "other", "deep"), join(cwd, "linked"));
  symlinkSync("loop", join(cwd, "loop"));
  assert.ok(guardReason("write", { path: "dangling.py" }, cwd, home));
  assert.ok(guardReason("write", { path: "linked/../escaped.py" }, cwd, home));
  assert.ok(guardReason("bash", { command: "cat linked/../../secret" }, cwd, home));
  assert.ok(guardReason("write", { path: "loop/x" }, cwd, home));
  assert.equal(guardReason("write", { path: "sub/../ok.py" }, cwd, home), undefined);
});
