import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import extension, { modelConfigs } from "./cadre.ts";

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
  const calls = { providers: {} as Record<string, any>, handlers: {} as Record<string, Function>, thinking: [] as string[] };
  const pi = {
    registerProvider: (name: string, config: unknown) => (calls.providers[name] = config),
    registerCommand: () => {},
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
