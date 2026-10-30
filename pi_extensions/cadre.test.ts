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
  assert.match(seen[2], /^\[web_search result, 39,034 characters, cleared from context after the answer\. Run web_search again if more of it is needed\. It began:\]\nSperm whales dive for 45 minutes\./);
  assert.ok(seen[2].length < 1000);
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
  assert.match(seen[2], /^\[read result, 10,807 characters, cleared from context to make room\. Run read again if more of it is needed\. It began:\]\nfile 0 /);
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
