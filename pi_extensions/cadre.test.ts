import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import extension from "./cadre.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Stubs fetch so /props, /health, and /tokenize on the given ports answer, and every other request fails. /tokenize
 * counts 1.8 characters per token on 8080 (Spark) and 2.6 on 8081 (LFM3), close to their real tokenizers on dense text.
 */
function serveProps(contexts: Record<number, number>) {
  const charsPerToken: Record<number, number> = { 8080: 1.8, 8081: 2.6 };
  globalThis.fetch = (async (url: string, init?: any) => {
    const port = Number(new URL(url).port);
    if (port in contexts && url.endsWith("/props")) {
      return new Response(JSON.stringify({ default_generation_settings: { n_ctx: contexts[port] } }));
    }
    if (port in contexts && url.endsWith("/health")) return new Response('{"status":"ok"}');
    if (port in contexts && url.endsWith("/apply-template")) {
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ prompt: JSON.stringify(body.messages) + JSON.stringify(body.tools ?? []) }));
    }
    if (port in contexts && url.endsWith("/tokenize")) {
      const n = Math.ceil(JSON.parse(init.body).content.length / charsPerToken[port]);
      return new Response(JSON.stringify({ tokens: new Array(n).fill(0) }));
    }
    throw new Error("connection refused");
  }) as typeof fetch;
}

/** Minimal ExtensionAPI stand-in that records registrations, model and thinking changes. */
function fakePi() {
  const calls = {
    providers: {} as Record<string, any>,
    virtual: {} as Record<string, any>,
    commands: {} as Record<string, any>,
    tools: {} as Record<string, any>,
    handlers: {} as Record<string, Function>,
    thinking: [] as string[],
    models: [] as any[],
  };
  const pi = {
    registerProvider: (name: string, config: unknown) => (calls.providers[name] = config),
    registerVirtualModel: (model: any) => (calls.virtual[`${model.provider}/${model.id}`] = model),
    registerCommand: (name: string, command: unknown) => (calls.commands[name] = command),
    registerTool: (tool: any) => (calls.tools[tool.name] = tool),
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
  const ask = { reason: "user", thinkingLevel: "off", messages: [{ role: "user", content: "What does `reserve` do?" }] };
  assert.equal((await cadre.route(ask, ctx)).model.id, "LiquidAI/LFM3-1.7B-GGUF:Q4_K_M");

  serveProps({ 8080: 32768, 8081: 2048 });
  const small = fakePi();
  await extension(small.pi as any);
  assert.equal((await small.calls.virtual["llama-cpp/cadre"].route(ask, ctx)).model.id, "XHToken/Spark-X2.6-4B-GGUF:Q4_K_M");
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
    await calls.handlers["before_agent_start"]({ messageType: "user", prompt }, uiContext(true).ctx);
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
  await calls.handlers["before_agent_start"]({ messageType: "user", prompt: "When was the release date?" }, uiContext(true).ctx);
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

test("the router counts the conversation on LFM3's tokenizer and moves to Spark when it does not fit", async () => {
  serveProps({ 8080: 32768, 8081: 16384 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  const cadre = calls.virtual["llama-cpp/cadre"];
  const { ctx } = uiContext(true);
  const previous = { model: { id: "LiquidAI/LFM3-1.7B-GGUF:Q4_K_M" }, thinkingLevel: "off" };
  const question = { role: "user", content: "What year was the largest prime number found?" };
  // 30,000 characters is about 11,500 LFM3 tokens: over the 12,288 left after a 4,096-token reply once the
  // conversation's other messages are added, so the turn moves to Spark.
  const big = { role: "toolResult", content: [{ type: "text", text: "| 2^136279841 - 1 | 41024320 |\n".repeat(1000) }] };
  const system = { role: "system", content: "s".repeat(3000) };
  const moved = await cadre.route({ reason: "continuation", previous, thinkingLevel: "off", messages: [system, question, big] }, ctx);
  assert.equal(moved.model.id, "XHToken/Spark-X2.6-4B-GGUF:Q4_K_M");
  const small = { role: "toolResult", content: [{ type: "text", text: "2024" }] };
  const stayed = await cadre.route({ reason: "continuation", previous, thinkingLevel: "off", messages: [system, question, small] }, ctx);
  assert.equal(stayed.model.id, "LiquidAI/LFM3-1.7B-GGUF:Q4_K_M");
});

test("tool_result shortens an oversized result until it fits on the denser tokenizer", async () => {
  serveProps({ 8080: 32768, 8081: 16384 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  await calls.handlers["before_agent_start"]({ messageType: "user", prompt: "What year was the largest prime number found?" }, uiContext(true).ctx);
  // About 76,000 characters of table rows, like the real search result, with the answer deep inside.
  // Every row matches the question, so the shortened result fills its limit and the check is a real bound.
  const rows = Array.from({ length: 2400 }, (_, i) => `| ${i} | largest prime candidate 2^${i * 7919} - 1 found in ${1990 + (i % 30)} |`);
  rows.splice(2000, 0, "The largest known prime was found in 2024.");
  const event = { toolName: "web_search", input: { query: "largest prime" }, content: [{ type: "text", text: rows.join("\n") }], details: {} };
  const result = await calls.handlers["tool_result"](event, { cwd: process.cwd() });
  const text = result.content.map((c: any) => c.text).join("");
  assert.ok(Math.ceil(text.length / 1.8) <= Math.floor(32768 * 0.25), `${Math.ceil(text.length / 1.8)} Spark tokens`);
  assert.match(text, /The largest known prime was found in 2024/);
});

/** Model-visible messages for a conversation whose tool result holds `chars` characters. */
function conversation(chars: number) {
  return [
    { role: "user", content: "What was the first sentence in the release notes of the initial release of linux" },
    { role: "assistant", content: [{ type: "toolCall", name: "web_search", arguments: { query: "linux 0.01" } }] },
    { role: "toolResult", toolName: "web_search", content: [{ type: "text", text: "r".repeat(chars) }] },
  ];
}

/** Context whose session projection holds `messages`, with a cadre model selected unless `provider` says otherwise. */
function sessionContext(messages: any[], provider = "llama-cpp") {
  const { ctx } = uiContext(true, { provider, id: "cadre" });
  return { ...ctx, sessionManager: { buildSessionProjection: () => ({ messages, entries: [] }) } };
}

test("threshold compaction is cancelled while the model-visible conversation still fits Spark", async () => {
  serveProps({ 8080: 32768, 8081: 16384 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  // 22,666 Pi-estimated tokens triggered compaction in the failing session; 36,000 characters is 20,000 Spark tokens.
  const event = { reason: "threshold", willRetry: false, branchEntries: [], preparation: {} };
  assert.deepEqual(await calls.handlers["session_before_compact"](event, sessionContext(conversation(36_000))), { cancel: true });
  assert.equal(await calls.handlers["session_before_compact"](event, sessionContext(conversation(60_000))), undefined);
});

test("overflow and manual compaction, and other providers' models, are left to Pi", async () => {
  serveProps({ 8080: 32768, 8081: 16384 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  for (const reason of ["overflow", "manual"]) {
    const event = { reason, branchEntries: [], preparation: {} };
    assert.equal(await calls.handlers["session_before_compact"](event, sessionContext(conversation(100))), undefined);
  }
  const event = { reason: "threshold", branchEntries: [], preparation: {} };
  assert.equal(await calls.handlers["session_before_compact"](event, sessionContext(conversation(100), "ollama")), undefined);
});

test("a large window does not raise the tool result limit above 8,192 tokens", async () => {
  serveProps({ 8080: 131072, 8081: 16384 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  await calls.handlers["before_agent_start"]({ messageType: "user", prompt: "What year was the largest prime number found?" }, uiContext(true).ctx);
  const rows = Array.from({ length: 2400 }, (_, i) => `| ${i} | largest prime candidate 2^${i * 7919} - 1 found in ${1990 + (i % 30)} |`);
  const event = { toolName: "web_search", input: { query: "largest prime" }, content: [{ type: "text", text: rows.join("\n") }], details: {} };
  const result = await calls.handlers["tool_result"](event, { cwd: process.cwd() });
  const text = result.content.map((c: any) => c.text).join("");
  assert.ok(Math.ceil(text.length / 1.8) <= 8192, `${Math.ceil(text.length / 1.8)} Spark tokens`);
});

/** Runs `body` with the extension loaded under CADRE_OPTS=digest. */
async function withDigest(body: (calls: ReturnType<typeof fakePi>["calls"]) => Promise<void>) {
  const saved = process.env.CADRE_OPTS;
  process.env.CADRE_OPTS = "digest";
  try {
    serveProps({ 8080: 32768, 8081: 16384 });
    const { pi, calls } = fakePi();
    await extension(pi as any);
    await body(calls);
  } finally {
    if (saved === undefined) delete process.env.CADRE_OPTS;
    else process.env.CADRE_OPTS = saved;
  }
}

/** Projected entries: an earlier compaction summary, then the given messages. */
function afterCompaction(...messages: any[]) {
  const summary = { role: "compactionSummary", summary: "Earlier in this session (condensed by cadre without a model; answers are verbatim):\n1. User asked: What year was the largest prime found?\n   Answer: 2024.\nThe current request and all work on it follow unchanged.", tokensBefore: 20_000, timestamp: 1 };
  return [
    { sourceEntry: { type: "compaction", id: "c1" }, messages: [summary] },
    ...messages.map((message, i) => ({ sourceEntry: { type: "message", id: `m${i}`, message }, messages: [message] })),
  ];
}

function digestContext(entries: any[]) {
  const { ctx } = uiContext(true, { provider: "llama-cpp", id: "cadre" });
  return { ...ctx, sessionManager: { buildSessionProjection: () => ({ messages: [], entries }) } };
}

test("the digest carries an earlier compaction summary forward", async () => {
  await withDigest(async (calls) => {
    const entries = afterCompaction(
      { role: "user", content: "Who wrote Linux?" },
      { role: "assistant", content: [{ type: "text", text: "Linus Torvalds." }] },
      { role: "user", content: "How long can a sperm whale dive?" },
    );
    const result = await calls.handlers["session_before_compact"]({ reason: "threshold", preparation: { tokensBefore: 25_000 } }, digestContext(entries));
    assert.match(result.compaction.summary, /Answer: 2024\./);
    assert.match(result.compaction.summary, /^2\. User asked: Who wrote Linux\?\n   Answer: Linus Torvalds\.$/m);
    assert.equal(result.compaction.summary.match(/Earlier in this session|follow unchanged/g)?.length, 2);
    assert.equal(result.compaction.firstKeptEntryId, "m2");
  });
});

test("the digest leaves compaction to Pi when only a summary precedes the current request", async () => {
  await withDigest(async (calls) => {
    // Cutting at the current request again would free nothing, and Pi would compact again at once.
    const entries = afterCompaction(
      { role: "user", content: "What was the first sentence of the Linux 0.01 release notes?" },
      { role: "assistant", content: [{ type: "toolCall", name: "web_search", arguments: { query: "linux 0.01" } }] },
      { role: "toolResult", toolName: "web_search", content: [{ type: "text", text: "r".repeat(40_000) }] },
    );
    const event = { reason: "threshold", preparation: { tokensBefore: 27_000 } };
    assert.equal(await calls.handlers["session_before_compact"](event, digestContext(entries)), undefined);
  });
});

test("the digest stays within its size limit over a long session, newest answers verbatim", async () => {
  await withDigest(async (calls) => {
    const messages = [];
    for (let i = 1; i <= 30; i++) {
      messages.push({ role: "user", content: `Question ${i}?` });
      messages.push({ role: "assistant", content: [{ type: "text", text: `Answer ${i}: ` + "a".repeat(1400) }] });
    }
    messages.push({ role: "user", content: "Question 31?" });
    const result = await calls.handlers["session_before_compact"]({ reason: "threshold", preparation: { tokensBefore: 25_000 } }, digestContext(afterCompaction(...messages)));
    const summary: string = result.compaction.summary;
    assert.ok(summary.length <= 8000, `${summary.length} characters`);
    assert.match(summary, /^31\. User asked: Question 30\?\n   Answer: Answer 30: a{1400}$/m);
    assert.match(summary, /^\d+\. User asked: Question 1\?|earlier questions omitted/m);
  });
});

test("the digest keeps a model-written summary and numbers only questions", async () => {
  await withDigest(async (calls) => {
    const model = { role: "compactionSummary", summary: "## Goal\n- Find the largest prime.", tokensBefore: 20_000, timestamp: 1 };
    const entries = [
      { sourceEntry: { type: "compaction", id: "c1" }, messages: [model] },
      ...[{ role: "user", content: "Who wrote Linux?" }, { role: "assistant", content: [{ type: "text", text: "Linus Torvalds." }] }, { role: "user", content: "Next?" }].map(
        (message, i) => ({ sourceEntry: { type: "message", id: `m${i}`, message }, messages: [message] }),
      ),
    ];
    const result = await calls.handlers["session_before_compact"]({ reason: "threshold", preparation: { tokensBefore: 25_000 } }, digestContext(entries));
    assert.match(result.compaction.summary, /## Goal\n- Find the largest prime\.\n1\. User asked: Who wrote Linux\?\n   Answer: Linus Torvalds\./);
  });
});

/** A real in-memory Pi session holding `messages`, so hooks see Pi's own projection and edits go through Pi. */
function realSession(messages: any[]) {
  const session = SessionManager.inMemory(process.cwd());
  const ids = messages.map((message, i) => session.appendMessage({ timestamp: i + 1, ...message }));
  return { session, ids };
}

/** A turn_end or agent_before_settle event over the session's current context. */
function boundary(session: SessionManager, extra: Record<string, unknown> = {}) {
  const { entries, messages } = session.buildSessionProjection();
  return { entries: [], continue: false, outcome: "completed", context: { contextEntries: entries, contextMessages: messages, llmMessages: [], pendingMessages: [], canContinue: true }, ...extra };
}

/** Applies a hook's context edits through Pi and returns the text of each message the model would see next. */
function applyEdits(session: SessionManager, result: any) {
  for (const entry of result?.entries ?? []) session.appendContextEdit(entry.targetId, entry.replacement);
  return session.buildSessionContext().messages.map((message: any) =>
    typeof message.content === "string" ? message.content : message.content.map((block: any) => block.text ?? "").join(""),
  );
}

const toolCall = (id: string, name: string, args: unknown) => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name, arguments: args }],
  api: "openai-completions",
  provider: "llama-cpp",
  model: "spark",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "toolUse",
});
const toolResult = (id: string, name: string, text: string) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false });
const answer = (text: string) => ({ ...toolCall("x", "x", {}), content: [{ type: "text", text }], stopReason: "stop" });

/** An answered question whose search result holds `chars` more characters. */
function answeredRun(chars: number) {
  return realSession([
    { role: "user", content: "How long can a sperm whale hold its breath?" },
    toolCall("c1", "web_search", { query: "sperm whale dive" }),
    toolResult("c1", "web_search", "Sperm whales dive for 45 minutes. " + "x".repeat(chars)),
    answer("About 45 minutes on average."),
  ]);
}

test("after an answered run, large tool results are replaced in the model's context by a short note", async () => {
  serveProps({ 8080: 32768, 8081: 16384 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  const { session } = answeredRun(39_000);
  const seen = applyEdits(session, await calls.handlers["agent_before_settle"](boundary(session), sessionContext([])));
  assert.match(seen[2], /^\[web_search result, 39,034 characters, cleared from context after the answer\. Facts you recorded with note stay in context\. Its opening and the lines matching its call and the request are kept below; run web_search again for the rest\.\]\nSperm whales dive for 45 minutes\./);
  assert.ok(seen[2].length < 1300);
  assert.equal(seen[3], "About 45 minutes on average.");
});

test("small results, notes already cleared, unfinished runs, and other providers keep their context", async () => {
  serveProps({ 8080: 32768, 8081: 16384 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  const settle = (session: SessionManager, extra = {}, provider = "llama-cpp") => calls.handlers["agent_before_settle"](boundary(session, extra), sessionContext([], provider));
  assert.equal(await settle(answeredRun(100).session), undefined);
  assert.equal(await settle(answeredRun(39_000).session, { outcome: "aborted" }), undefined);
  assert.equal(await settle(answeredRun(39_000).session, {}, "ollama"), undefined);
  const { session } = answeredRun(39_000);
  applyEdits(session, await settle(session));
  assert.equal(await settle(session), undefined);
});

/** A task in progress: a request, then one read per turn with a `chars`-character result each. */
function taskInProgress(...chars: number[]) {
  const messages: any[] = [{ role: "user", content: "Add a restock report to the inventory project and test it." }];
  chars.forEach((n, i) => messages.push(toolCall(`c${i}`, "read", { path: `f${i}.py` }), toolResult(`c${i}`, "read", `file ${i} ` + "x".repeat(n))));
  const { session, ids } = realSession(messages);
  return { session, resultIds: chars.map((_, i) => ids[2 + 2 * i]) };
}

const turnEnd = (task: ReturnType<typeof taskInProgress>) => boundary(task.session, { type: "turn_end", toolResultEntryIds: [task.resultIds.at(-1)] });

test("during a task, older tool results are cleared once the kept results pass their budget", async () => {
  serveProps({ 8080: 32768, 8081: 16384 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  // Spark's window leaves (32,768 - 8,192 reply - 4,096 system) / 2 = 10,240 tokens for kept results. At 1.8 characters
  // per token each 10,800-character result is about 6,000 tokens: the newest seen one stays, the two before it go,
  // and the result the model has not read yet stays whatever its size.
  const task = taskInProgress(10_800, 10_800, 10_800, 30_000);
  const seen = applyEdits(task.session, await calls.handlers["turn_end"](turnEnd(task), sessionContext([])));
  assert.match(seen[2], /^\[read result, 10,807 characters, cleared from context to make room\. .*\]\nfile 0 /);
  assert.match(seen[4], /^\[read result, 10,807 characters, cleared/);
  assert.equal(seen[6].length, 10_807);
  assert.equal(seen[8].length, 30_007);
});

test("during a task, results within the budget, other providers, and cleared notes are left alone", async () => {
  serveProps({ 8080: 32768, 8081: 16384 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  const end = (task: ReturnType<typeof taskInProgress>, provider = "llama-cpp") => calls.handlers["turn_end"](turnEnd(task), sessionContext([], provider));
  assert.equal(await end(taskInProgress(5_000, 5_000, 30_000)), undefined);
  assert.equal(await end(taskInProgress(10_800, 10_800, 10_800, 100), "ollama"), undefined);
  const task = taskInProgress(10_800, 10_800, 10_800, 100);
  applyEdits(task.session, await end(task));
  assert.equal(await end(task), undefined);
});

test("parallel tool calls from one response share the room for new results", async () => {
  serveProps({ 8080: 32768, 8081: 16384 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  await calls.handlers["before_agent_start"]({ messageType: "user", prompt: "Research six facts and write research.md" }, uiContext(true).ctx);
  const searches = Array.from({ length: 6 }, (_, i) => ({ type: "toolCall", id: `c${i}`, name: "web_search", arguments: { query: `fact ${i}` } }));
  await calls.handlers["message_end"]({ type: "message_end", message: { role: "assistant", content: searches } }, uiContext(true).ctx);
  // Six results of about 12,000 Spark tokens each overflowed a 32,768 window together (a real 39,699-token request).
  // New results share half of what the window leaves after the reply and system prompt: 10,240 / 6 = 1,706 each.
  const text = Array.from({ length: 600 }, (_, i) => `row ${i}: a search result line about fact ${i % 6}`).join("\n");
  for (const call of searches) {
    const result = await calls.handlers["tool_result"]({ toolName: "web_search", toolCallId: call.id, input: call.arguments, content: [{ type: "text", text }], details: {} }, { cwd: process.cwd() });
    const short = result.content.map((c: any) => c.text).join("");
    assert.ok(Math.ceil(short.length / 1.8) <= 1706, `${Math.ceil(short.length / 1.8)} Spark tokens`);
  }
});

test("each request's reply limit is what the server's slot has left after the real prompt", async () => {
  serveProps({ 8080: 32768, 8081: 16384 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  const request = (model: string, chars: number, cap: Record<string, number>) => ({
    type: "before_provider_request",
    payload: { model, messages: [{ role: "user", content: "x".repeat(chars) }], stream: true, ...cap },
  });
  // Pi capped a reply at 17 tokens from a stale estimate while the slot had room; the real prompt sets the limit.
  const fresh = await calls.handlers["before_provider_request"](request("XHToken/Spark-X2.6-4B-GGUF:Q4_K_M", 1000, { max_completion_tokens: 17 }), uiContext(true).ctx);
  assert.equal(fresh.max_completion_tokens, 8192);
  assert.equal(fresh.stream, true);
  // A 45,000-character prompt is about 25,000 Spark tokens: the limit is what the 32,768-token slot has left.
  const full = await calls.handlers["before_provider_request"](request("XHToken/Spark-X2.6-4B-GGUF:Q4_K_M", 45_000, { max_tokens: 8192 }), uiContext(true).ctx);
  assert.equal(full.max_tokens, 32768 - Math.ceil(JSON.stringify([{ role: "user", content: "x".repeat(45_000) }]).concat("[]").length / 1.8) - 64);
  const lfm3 = await calls.handlers["before_provider_request"](request("LiquidAI/LFM3-1.7B-GGUF:Q4_K_M", 1000, { max_tokens: 1 }), uiContext(true).ctx);
  assert.equal(lfm3.max_tokens, 4096);
  assert.equal(await calls.handlers["before_provider_request"](request("gemma", 1000, { max_tokens: 1 }), uiContext(true).ctx), undefined);
});

test("a cleared result keeps the lines that match its tool call and the request", async () => {
  serveProps({ 8080: 32768, 8081: 16384 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  await calls.handlers["before_agent_start"]({ messageType: "user", prompt: "Research six facts and write research.md" }, uiContext(true).ctx);
  // The real failure: the 90-minute line sat deep in a cleared search result, and the model then answered from memory.
  const page = [...Array(60).fill("Whales are marine mammals found in every ocean."), "A sperm whale can spend around 90 minutes hunting underwater.", ...Array(60).fill("Other species vary widely.")].join("\n");
  const { session } = realSession([
    { role: "user", content: "Research six facts and write research.md" },
    toolCall("c1", "web_search", { query: "sperm whale typical breath holding dive time" }),
    toolResult("c1", "web_search", page),
    answer("Done."),
  ]);
  const seen = applyEdits(session, await calls.handlers["agent_before_settle"](boundary(session), sessionContext([])));
  assert.match(seen[2], /A sperm whale can spend around 90 minutes hunting underwater\./);
  assert.ok(seen[2].length <= 1200, `${seen[2].length} characters`);
});

test("once kept extracts pass their budget, the oldest cleared results shrink to a one-line note", async () => {
  serveProps({ 8080: 32768, 8081: 16384 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  const messages: any[] = [{ role: "user", content: "Read every module and summarize it." }];
  for (let i = 0; i < 30; i++) messages.push(toolCall(`c${i}`, "read", { path: `m${i}.py` }), toolResult(`c${i}`, "read", `module ${i}\n` + "def f():\n    return 1\n".repeat(400)));
  messages.push(answer("Summary written."));
  const { session } = realSession(messages);
  const seen = applyEdits(session, await calls.handlers["agent_before_settle"](boundary(session), sessionContext([])));
  const results = seen.filter((text: string) => text.startsWith("[read result"));
  assert.equal(results.length, 30);
  const total = results.reduce((sum: number, text: string) => sum + text.length, 0);
  assert.ok(total <= 12_000 + 30 * 120, `${total} characters`);
  assert.match(results[29], /module 29/);
  assert.doesNotMatch(results[0], /module 0/);
  assert.match(results[0], /^\[read result, [\d,]+ characters, cleared from context\. Facts you recorded with note stay in context; run read again if it is needed\.\]$/);
});

test("the note tool is registered and says why it exists", async () => {
  serveProps({ 8080: 32768, 8081: 16384 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  assert.match(calls.tools["note"].description, /cleared/);
});

test("a cleared result's note points the model to its notes, and the rules say when to take them", async () => {
  serveProps({ 8080: 32768, 8081: 16384 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  const { session } = answeredRun(39_000);
  const seen = applyEdits(session, await calls.handlers["agent_before_settle"](boundary(session), sessionContext([])));
  assert.match(seen[2], /Facts you recorded with note stay in context/);
  const system = { role: "system", content: "Pi system prompt" };
  await calls.handlers["context_with_system"]({ messages: [system] });
  assert.match(system.content, /note/);
});

/** Context for a tool's execute with the session's branch. */
const toolContext = (session: SessionManager) => ({ ...uiContext(true, { provider: "llama-cpp", id: "cadre" }).ctx, sessionManager: session });

test("the note tool refuses a fact the session's tool results do not contain, including cleared ones", async () => {
  serveProps({ 8080: 32768, 8081: 16384 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  const { session } = realSession([
    { role: "user", content: "Research Everest's height." },
    toolCall("c1", "web_search", { query: "everest 2020 survey" }),
    toolResult("c1", "web_search", "The 2020 China-Nepal survey measured Mount Everest at 8,848.86 metres. " + "x".repeat(5000)),
  ]);
  applyEdits(session, await calls.handlers["agent_before_settle"](boundary(session), sessionContext([])));
  const note = calls.tools["note"];
  const ok = await note.execute("n1", { topic: "Everest height", fact: "8,848.86 m (2020 China-Nepal survey)", source: "web_search everest 2020 survey" }, undefined, undefined, toolContext(session));
  assert.equal(ok.content[0].text, "Noted.");
  await assert.rejects(
    note.execute("n2", { topic: "Everest height", fact: "8,848.86 m (7,749.21 m above sea level)", source: "web_search" }, undefined, undefined, toolContext(session)),
    /Not noted: 7,749\.21 is not in any tool result in this session/,
  );
});

test("a later note on the same topic marks the earlier one superseded", async () => {
  serveProps({ 8080: 32768, 8081: 16384 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  const noteCall = (id: string, fact: string) => ({ ...toolCall(id, "note", { topic: "Tokyo population", fact, source: "web_search" }) });
  const { session } = realSession([
    { role: "user", content: "Research Tokyo." },
    noteCall("n1", "Tokyo metropolis: 14,192,184"),
    toolResult("n1", "note", "Noted."),
    noteCall("n2", "Tokyo metropolis 14,192,184; 23 wards 9,873,999"),
    toolResult("n2", "note", "Noted."),
  ]);
  const seen = applyEdits(session, await calls.handlers["turn_end"](boundary(session, { type: "turn_end", toolResultEntryIds: [] }), sessionContext([])));
  assert.equal(seen[2], "Superseded by a later note on Tokyo population.");
  assert.equal(seen[4], "Noted.");
});

test("notes that compaction removed come back before the next request, latest per topic", async () => {
  serveProps({ 8080: 32768, 8081: 16384 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  const note = (id: string, topic: string, fact: string) => toolCall(id, "note", { topic, fact, source: "web_search" });
  const { session, ids } = realSession([
    { role: "user", content: "Research twelve facts and write research.md" },
    note("n1", "Largest prime", "2^136,279,841 - 1, found 2024, 41,024,320 digits"),
    toolResult("n1", "note", "Noted."),
    note("n2", "Whale dive", "up to 45 minutes"),
    toolResult("n2", "note", "Noted."),
    note("n3", "Whale dive", "around 90 minutes hunting underwater"),
    toolResult("n3", "note", "Noted."),
    toolCall("c1", "web_search", { query: "tokyo population" }),
    toolResult("c1", "web_search", "Tokyo 14,192,184"),
    note("n4", "Tokyo population", "14,192,184 (metropolis)"),
    toolResult("n4", "note", "Noted."),
  ]);
  // Compaction keeps only the last search onward: the first three notes leave context.
  session.appendCompaction("Turn context (split turn): researching twelve facts.", ids[7], 20_000);
  const messages = session.buildSessionContext().messages;
  const result = await calls.handlers["context"]({ type: "context", messages }, toolContext(session));
  const restored = result.messages.find((m: any) => m.role === "user" && JSON.stringify(m.content).includes("Your notes"));
  assert.ok(restored, "notes message added");
  const text = JSON.stringify(restored.content);
  assert.match(text, /Largest prime: 2\^136,279,841 - 1, found 2024, 41,024,320 digits/);
  assert.match(text, /Whale dive: around 90 minutes hunting underwater/);
  assert.doesNotMatch(text, /up to 45 minutes/);
  assert.doesNotMatch(text, /Tokyo population/, "a note still in context is not repeated");
  assert.equal(result.messages.indexOf(restored), 1, "right after the compaction summary");

  const { session: plain } = realSession([{ role: "user", content: "q" }, note("n1", "t", "f"), toolResult("n1", "note", "Noted.")]);
  assert.equal(await calls.handlers["context"]({ type: "context", messages: plain.buildSessionContext().messages }, toolContext(plain)), undefined);
});

test("a rejected note is never restored", async () => {
  serveProps({ 8080: 32768, 8081: 16384 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  const { session, ids } = realSession([
    { role: "user", content: "Research Everest" },
    toolCall("n1", "note", { topic: "Everest", fact: "7,749.21 m", source: "web_search" }),
    { ...toolResult("n1", "note", "Not noted: 7,749.21 is not in any tool result in this session."), isError: true },
    toolCall("c1", "web_search", { query: "q" }),
    toolResult("c1", "web_search", "r"),
  ]);
  session.appendCompaction("summary", ids[3], 10_000);
  assert.equal(await calls.handlers["context"]({ type: "context", messages: session.buildSessionContext().messages }, toolContext(session)), undefined);
});

test("a large result tells the model, as it reads it, to note what it needs before the result leaves context", async () => {
  serveProps({ 8080: 32768, 8081: 16384 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  await calls.handlers["before_agent_start"]({ messageType: "user", prompt: "Research twelve facts" }, uiContext(true).ctx);
  const ctx = { ...uiContext(true, { provider: "llama-cpp", id: "cadre" }).ctx, cwd: process.cwd() };
  const event = (text: string) => ({ toolName: "web_search", toolCallId: "c1", input: { query: "q" }, content: [{ type: "text", text }], details: {} });
  const large = await calls.handlers["tool_result"](event("The 2024 prime has 41,024,320 digits. " + "x".repeat(3000)), ctx);
  assert.match(large.content.at(-1).text, /can leave context after your next step.*note/i);
  assert.equal(await calls.handlers["tool_result"](event("short result"), ctx), undefined);
  const other = await calls.handlers["tool_result"](event("y".repeat(3000)), { ...ctx, model: { provider: "ollama", id: "gemma" } });
  assert.equal(other, undefined);
});

test("with recall, passages of cleared web results that match the task come back at the end of the request", async () => {
  const saved = process.env.CADRE_OPTS;
  process.env.CADRE_OPTS = "clear,recall";
  try {
    serveProps({ 8080: 32768, 8081: 16384 });
    const { pi, calls } = fakePi();
    await extension(pi as any);
    const prompt = "Research each of these and write research.md:\n1. The year the largest known prime number was found, and its digits.\n2. The local config path.";
    const prime = "The largest known prime number is 2^136,279,841 - 1, with 41,024,320 digits, found in October 2024.\n\n" + "filler line\n".repeat(300);
    const config = "The local config path is /etc/app/largest-prime.conf, found in 2024 digits.\n\n" + "z\n".repeat(2000);
    const { session, ids } = realSession([
      { role: "user", content: prompt },
      toolCall("c1", "web_search", { query: "largest known prime" }),
      toolResult("c1", "web_search", prime),
      toolCall("c2", "read", { path: "config.txt" }),
      toolResult("c2", "read", config),
    ]);
    // Both results were cleared; only the web result may be recalled, since a file can have changed since it was read.
    session.appendContextEdit(ids[2], { content: "[web_search result cleared]" });
    session.appendContextEdit(ids[4], { content: "[read result cleared]" });
    const result = await calls.handlers["context"]({ type: "context", messages: session.buildSessionContext().messages }, toolContext(session));
    const last = result.messages.at(-1);
    assert.equal(last.role, "user");
    const text = JSON.stringify(last.content);
    assert.match(text, /Passages from earlier tool results/);
    assert.match(text, /41,024,320 digits/);
    assert.match(text, /web_search \{\\"query\\":\\"largest known prime\\"\}/);
    assert.doesNotMatch(text, /etc\/app/);

    // Nothing cleared: nothing to recall.
    const { session: fresh } = realSession([{ role: "user", content: prompt }, toolCall("c1", "web_search", { query: "q" }), toolResult("c1", "web_search", prime)]);
    assert.equal(await calls.handlers["context"]({ type: "context", messages: fresh.buildSessionContext().messages }, toolContext(fresh)), undefined);
  } finally {
    if (saved === undefined) delete process.env.CADRE_OPTS;
    else process.env.CADRE_OPTS = saved;
  }
});
