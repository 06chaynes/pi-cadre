import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import extension from "./cadre.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stubs fetch so /props and /health on the given ports report n_ctx, and every other request fails. */
function serveProps(contexts: Record<number, number>) {
  globalThis.fetch = (async (url: string) => {
    const port = Number(new URL(url).port);
    if (port in contexts && url.endsWith("/props")) {
      return new Response(JSON.stringify({ default_generation_settings: { n_ctx: contexts[port] } }));
    }
    if (port in contexts && url.endsWith("/health")) return new Response('{"status":"ok"}');
    throw new Error("connection refused");
  }) as typeof fetch;
}

/** Minimal ExtensionAPI stand-in that records registrations, model and thinking changes. */
function fakePi() {
  const calls = {
    providers: {} as Record<string, any>,
    virtual: {} as Record<string, any>,
    commands: {} as Record<string, any>,
    handlers: {} as Record<string, Function>,
    thinking: [] as string[],
    models: [] as any[],
  };
  const pi = {
    registerProvider: (name: string, config: unknown) => (calls.providers[name] = config),
    registerVirtualModel: (model: any) => (calls.virtual[`${model.provider}/${model.id}`] = model),
    registerCommand: (name: string, command: unknown) => (calls.commands[name] = command),
    on: (event: string, handler: Function) => (calls.handlers[event] = handler),
    setThinkingLevel: (level: string) => calls.thinking.push(level),
    setModel: async (model: unknown) => (calls.models.push(model), true),
  };
  return { pi, calls };
}

/** Context with a UI whose confirm dialogs answer `answer`, recording their titles. */
function uiContext(answer: boolean, model?: { provider: string; id: string }) {
  const asked: string[] = [];
  const registry = { find: (provider: string, id: string) => ({ provider, id, contextWindow: 16384, maxTokens: 4096 }) };
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    model,
    modelRegistry: registry,
    ui: { notify: () => {}, confirm: async (title: string) => (asked.push(title), answer) },
  };
  return { ctx, asked };
}

test("registers the llama-cpp provider from live servers", async () => {
  serveProps({ 8080: 131072 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  const provider = calls.providers["llama-cpp"];
  assert.equal(provider.api, "openai-completions");
  assert.equal(provider.apiKey, "none");
  assert.deepEqual(provider.models.map((m: any) => m.contextWindow), [131072, 16384]);
});

test("registers the cadre router, which uses LFM3 only when its slots are large enough", async () => {
  serveProps({ 8080: 32768, 8081: 16384 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  const cadre = calls.virtual["llama-cpp/cadre"];
  assert.ok(cadre);
  const { ctx } = uiContext(true);
  const ask = { reason: "user", thinkingLevel: "off", messages: [{ role: "user", content: "What does reserve do?" }] };
  assert.equal(cadre.route(ask, ctx).model.id, "LiquidAI/LFM3-1.7B-GGUF:Q4_K_M");

  serveProps({ 8080: 32768, 8081: 2048 });
  const small = fakePi();
  await extension(small.pi as any);
  assert.equal(small.calls.virtual["llama-cpp/cadre"].route(ask, ctx).model.id, "XHToken/Spark-X2.6-4B-GGUF:Q4_K_M");
});

test("at startup with a UI, offers to switch to cadre when another model is selected", async () => {
  serveProps({ 8080: 32768, 8081: 16384 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  const { ctx, asked } = uiContext(true, { provider: "ollama", id: "gemma" });
  await calls.handlers["session_start"]({ reason: "startup" }, ctx);
  assert.equal(asked.length, 1);
  assert.deepEqual(calls.models.map((m: any) => `${m.provider}/${m.id}`), ["llama-cpp/cadre"]);
});

test("does not prompt when a llama-cpp model is selected, or without a UI", async () => {
  serveProps({ 8080: 32768, 8081: 16384 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  const selected = uiContext(true, { provider: "llama-cpp", id: "cadre" });
  await calls.handlers["session_start"]({ reason: "startup" }, selected.ctx);
  const headless = uiContext(true, { provider: "ollama", id: "gemma" });
  await calls.handlers["session_start"]({ reason: "startup" }, { ...headless.ctx, hasUI: false });
  assert.deepEqual([selected.asked, headless.asked, calls.models], [[], [], []]);
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

test("the tool_call hook blocks until /cadre-guard off", async () => {
  serveProps({});
  const { pi, calls } = fakePi();
  await extension(pi as any);
  const { ctx } = uiContext(true);
  const call = { toolName: "bash", input: { command: "find / -name x" } };
  const blocked = await calls.handlers["tool_call"](call, ctx);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /outside the project/);
  await calls.commands["cadre-guard"].handler("off", ctx);
  assert.equal(await calls.handlers["tool_call"](call, ctx), undefined);
});

test("tool_result appends unseen matching lines to a truncated read", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  serveProps({});
  const { pi, calls } = fakePi();
  await extension(pi as any);
  const cwd = mkdtempSync(join(tmpdir(), "cadre-tr-"));
  writeFileSync(join(cwd, "log.txt"), [...Array(50).fill("filler line"), "the release date was March 3"].join("\n"));
  await calls.handlers["before_agent_start"]({ prompt: "When was the release date?" });
  const event = {
    toolName: "read",
    input: { path: "log.txt" },
    content: [{ type: "text", text: "filler line" }],
    details: { truncation: { truncated: true, outputLines: 10, totalLines: 51 } },
  };
  const result = await calls.handlers["tool_result"](event, { cwd });
  assert.equal(result.content[0].text, "filler line");
  assert.match(result.content[1].text, /^51: the release date was March 3$/m);
});

test("tool_result shortens any oversized result to fit the largest context", async () => {
  serveProps({ 8080: 32768, 8081: 16384 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  await calls.handlers["before_agent_start"]({ prompt: "What year was the largest prime number found?" });
  const rows = Array.from({ length: 3000 }, (_, i) => `| ${i} | candidate row with digits and notes |`);
  rows.splice(2500, 0, "The largest known prime was found in 2024.");
  const event = { toolName: "web_search", input: { query: "largest prime" }, content: [{ type: "text", text: rows.join("\n") }], details: {} };
  const result = await calls.handlers["tool_result"](event, { cwd: process.cwd() });
  const text = result.content.map((c: any) => c.text).join("");
  assert.ok(text.length <= Math.floor(32768 * 0.4 * 3), String(text.length));
  assert.match(text, /The largest known prime was found in 2024/);
});
