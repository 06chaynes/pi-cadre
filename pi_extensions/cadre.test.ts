import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  return { ...ctx, sessionManager: { buildSessionProjection: () => ({ messages, entries: [] }), getBranch: () => messages.map((message) => ({ type: "message", message })) } };
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
  const branch = entries.flatMap((e) => (e.sourceEntry.type === "message" ? [{ type: "message", message: e.messages[0] }] : []));
  return { ...ctx, sessionManager: { buildSessionProjection: () => ({ messages: [], entries }), getBranch: () => branch } };
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
  assert.match(seen[2], /^\[web_search result, 39,034 characters, cleared from context after the answer\. Its opening and the lines matching its call and the request are kept below; run web_search again for the rest\.\]\nSperm whales dive for 45 minutes\./);
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

test("during a task, results within the budget, other providers, and results already cleared are left alone", async () => {
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
  assert.match(results[0], /^\[read result, [\d,]+ characters, cleared from context\. Run read again if it is needed\.\]$/);
});

/** Context for a hook that reads the session's branch. */
const toolContext = (session: SessionManager) => ({ ...uiContext(true, { provider: "llama-cpp", id: "cadre" }).ctx, sessionManager: session });

test("with recall, passages of a cleared web result that match the task are restored inside that result", async () => {
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
    // Both results were cleared. Only web results are recalled (a file can have changed since it was read).
    session.appendContextEdit(ids[2], { content: "[web_search result cleared]" });
    session.appendContextEdit(ids[4], { content: "[read result cleared]" });
    const messages = session.buildSessionContext().messages;
    const result = await calls.handlers["context"]({ type: "context", messages }, toolContext(session));
    assert.equal(result.messages.length, messages.length, "nothing is added; passages go back where they came from");
    const restored = JSON.stringify(result.messages[2].content);
    assert.equal(result.messages[2].role, "toolResult");
    assert.match(restored, /\[web_search result cleared\]/);
    assert.match(restored, /Passages of this result that match the task/);
    assert.match(restored, /41,024,320 digits/);
    assert.doesNotMatch(JSON.stringify(result.messages[4].content), /etc\/app/);

    // Nothing cleared: nothing to recall.
    const { session: fresh } = realSession([{ role: "user", content: prompt }, toolCall("c1", "web_search", { query: "q" }), toolResult("c1", "web_search", prime)]);
    assert.equal(await calls.handlers["context"]({ type: "context", messages: fresh.buildSessionContext().messages }, toolContext(fresh)), undefined);
  } finally {
    if (saved === undefined) delete process.env.CADRE_OPTS;
    else process.env.CADRE_OPTS = saved;
  }
});

test("with recall, passages of a result that compaction removed come back right after the summary as tool output", async () => {
  const saved = process.env.CADRE_OPTS;
  process.env.CADRE_OPTS = "clear,recall";
  try {
    serveProps({ 8080: 32768, 8081: 16384 });
    const { pi, calls } = fakePi();
    await extension(pi as any);
    const prompt = "Research each of these:\n1. The year the largest known prime number was found, and its digits.\n2. Who won the 2024 Nobel Prize in Physics.";
    const { session, ids } = realSession([
      { role: "user", content: prompt },
      toolCall("c1", "web_search", { query: "largest known prime" }),
      toolResult("c1", "web_search", "The largest known prime number is 2^136,279,841 - 1, with 41,024,320 digits, found in October 2024.\n\n" + "filler\n".repeat(300)),
      toolCall("c2", "web_search", { query: "nobel physics 2024" }),
      toolResult("c2", "web_search", "Hopfield and Hinton won the 2024 Nobel Prize in Physics."),
    ]);
    session.appendCompaction("Researching two facts.", ids[3], 20_000);
    const messages = session.buildSessionContext().messages;
    const result = await calls.handlers["context"]({ type: "context", messages }, toolContext(session));
    const [call, back] = result.messages.slice(1, 3);
    assert.equal(call.role, "assistant");
    assert.deepEqual([back.role, back.toolName], ["toolResult", "recall"]);
    assert.match(JSON.stringify(back.content), /41,024,320 digits/);
    assert.ok(!result.messages.some((m: any) => m.role === "user" && JSON.stringify(m.content).includes("41,024,320")));
  } finally {
    if (saved === undefined) delete process.env.CADRE_OPTS;
    else process.env.CADRE_OPTS = saved;
  }
});

test("reasoning from earlier steps leaves the request; the latest step keeps its own", async () => {
  serveProps({ 8080: 32768, 8081: 16384 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  const think = (id: string, thinking: string) => ({ ...toolCall(id, "read", { path: "a.py" }), content: [{ type: "thinking", thinking }, { type: "toolCall", id, name: "read", arguments: { path: "a.py" } }] });
  const { session } = realSession([
    { role: "user", content: "Fix the bug" },
    think("c1", "STEP-ONE reasoning"),
    toolResult("c1", "read", "x = 1"),
    think("c2", "STEP-TWO reasoning"),
    toolResult("c2", "read", "y = 2"),
  ]);
  const messages = session.buildSessionContext().messages;
  const result = await calls.handlers["context"]({ type: "context", messages }, toolContext(session));
  const text = JSON.stringify(result.messages);
  assert.doesNotMatch(text, /STEP-ONE reasoning/);
  assert.match(text, /STEP-TWO reasoning/);
  assert.equal(result.messages[1].content.length, 1, "the earlier step keeps its tool call");
  assert.match(JSON.stringify(session.buildSessionContext().messages), /STEP-ONE reasoning/, "the session itself is unchanged");
});

test("with think, auto thinking defaults to low and uses high for reasoning prompts", async () => {
  const saved = process.env.CADRE_OPTS;
  process.env.CADRE_OPTS = "think";
  try {
    serveProps({});
    const { pi, calls } = fakePi();
    await extension(pi as any);
    for (const prompt of ["Review store.py for edge cases", "Add a restock_report method", "Research twelve facts"]) {
      await calls.handlers["before_agent_start"]({ messageType: "user", prompt }, uiContext(true).ctx);
    }
    assert.deepEqual(calls.thinking, ["high", "low", "low"]);
  } finally {
    if (saved === undefined) delete process.env.CADRE_OPTS;
    else process.env.CADRE_OPTS = saved;
  }
});

test("an oversized search result keeps every hit, a cut read says how to see more, and huge text is cut before counting", async () => {
  serveProps({ 8080: 32768, 8081: 16384 });
  const served = globalThis.fetch;
  let largestCounted = 0;
  globalThis.fetch = (async (url: string, init?: any) => {
    if (String(url).endsWith("/tokenize")) largestCounted = Math.max(largestCounted, JSON.parse(init.body).content.length);
    return served(url, init);
  }) as typeof fetch;
  const { pi, calls } = fakePi();
  await extension(pi as any);
  await calls.handlers["before_agent_start"]({ messageType: "user", prompt: "What are the latest research results in the field of ML" }, uiContext(true).ctx);
  const hit = (n: number, url: string) => `${n}. Hit ${n}\n   URL: ${url}\n   ` + Array.from({ length: 30000 }, (_, i) => `line ${i} about ML research results`).join("\n");
  const search = [hit(1, "https://a.example/1"), hit(2, "https://b.example/2"), hit(3, "https://c.example/3")].join("\n\n");
  const event = { toolName: "web_search", toolCallId: "s1", input: { query: "latest ML research" }, content: [{ type: "text", text: search }], details: {} };
  const result = await calls.handlers["tool_result"](event, { cwd: process.cwd() });
  const text = result.content.map((c: any) => c.text).join("");
  for (const url of ["https://a.example/1", "https://b.example/2", "https://c.example/3"]) assert.ok(text.includes(url), url);
  assert.ok(search.length > 2_000_000 && largestCounted < 200_000, `${largestCounted} characters sent to /tokenize`);

  const file = { toolName: "read", toolCallId: "r1", input: { path: "big.txt" }, content: [{ type: "text", text: "word\n".repeat(60_000) }], details: {} };
  const read = await calls.handlers["tool_result"](file, { cwd: process.cwd() });
  assert.match(read.content.map((c: any) => c.text).join(""), /Read again with offset and limit to see other parts\./);
});

test("a web search asking for more than 5 results is capped at the tool's default of 5", async () => {
  serveProps({});
  const { pi, calls } = fakePi();
  await extension(pi as any);
  const { ctx } = uiContext(true);
  const call = { toolName: "web_search", input: { query: "latest ML research", max_results: 10 } };
  assert.equal(await calls.handlers["tool_call"](call, ctx), undefined);
  assert.equal(call.input.max_results, 5);
  const small = { toolName: "web_search", input: { query: "q", max_results: 3 } };
  await calls.handlers["tool_call"](small, ctx);
  assert.equal(small.input.max_results, 3);
});

test("with recall, a passage cut from a shortened web result comes back from its saved original, for the item it answers", async () => {
  const saved = { opts: process.env.CADRE_OPTS, state: process.env.XDG_STATE_HOME };
  process.env.CADRE_OPTS = "clear,recall";
  process.env.XDG_STATE_HOME = (await import("node:fs")).mkdtempSync(join(tmpdir(), "cadre-state-"));
  try {
    serveProps({ 8080: 32768, 8081: 16384 });
    const { pi, calls } = fakePi();
    await extension(pi as any);
    const prompt = "Research each of these:\n1. The year the largest known prime number was found, and its digits.\n2. Who won the 2024 Nobel Prize in Physics.";
    await calls.handlers["before_agent_start"]({ messageType: "user", prompt }, uiContext(true).ctx);
    // Hundreds of lines match item 1 closely, so shortening (which ranks lines against the whole request) fills its
    // room with them and cuts the one line that answers item 2.
    const item1 = Array.from({ length: 3000 }, (_, i) => `Record ${i}: the largest known prime number of its year was found with these digits.`).join("\n");
    const big = item1 + "\n\nHopfield and Hinton won the 2024 Nobel Prize in Physics for work on neural networks.\n\n" + "tail\n".repeat(100);
    const { session } = realSession([{ role: "user", content: prompt }, toolCall("c1", "web_fetch", { url: "https://x.example" })]);
    const event = { toolName: "web_fetch", toolCallId: "c1", input: { url: "https://x.example" }, content: [{ type: "text", text: big }], details: {} };
    const ctx = { ...toolContext(session), cwd: process.cwd() };
    const shortened = await calls.handlers["tool_result"](event, ctx);
    const shown = shortened.content.map((c: any) => c.text).join("");
    assert.doesNotMatch(shown, /Hopfield and Hinton/, "the answer to item 2 was cut");
    session.appendMessage({ ...toolResult("c1", "web_fetch", shown), timestamp: 3 } as any);
    const result = await calls.handlers["context"]({ type: "context", messages: session.buildSessionContext().messages }, ctx);
    assert.match(JSON.stringify(result.messages.at(-1).content), /Hopfield and Hinton won the 2024 Nobel Prize in Physics/);
  } finally {
    for (const [key, value] of [["CADRE_OPTS", saved.opts], ["XDG_STATE_HOME", saved.state]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("the digest condenses earlier steps of the current request without a model, keeping the request verbatim", async () => {
  await withDigest(async (calls) => {
    const prompt = "Research each of these and write research.md:\n1. The largest known prime.\n2. The 2024 Nobel Prize in Physics.";
    const messages: any[] = [{ role: "user", content: prompt }];
    for (let i = 0; i < 6; i++) {
      messages.push(toolCall(`c${i}`, "web_search", { query: `query ${i}` }));
      messages.push(toolResult(`c${i}`, "web_search", `1. Result title ${i}\n   URL: https://example.org/${i}\n   body ${i}`));
    }
    const { session, ids } = realSession(messages);
    const ctx = { ...uiContext(true, { provider: "llama-cpp", id: "cadre" }).ctx, sessionManager: session };
    const result = await calls.handlers["session_before_compact"]({ reason: "threshold", preparation: { tokensBefore: 23_000 } }, ctx);
    const { summary, firstKeptEntryId } = result.compaction;
    assert.equal(firstKeptEntryId, ids[7], "the last three steps are kept in full");
    assert.ok(summary.includes(prompt), "the request is kept verbatim");
    assert.match(summary, /1\. web_search \{"query":"query 0"\} → 1\. Result title 0/);
    assert.match(summary, /3\. web_search \{"query":"query 2"\} → 1\. Result title 2/);
    assert.doesNotMatch(summary, /query 3/);
    session.appendCompaction(summary, firstKeptEntryId, 23_000);
    const after = session.buildSessionContext().messages;
    assert.equal(after[0].role, "compactionSummary");
    assert.equal(after[1].role, "assistant");
    const callIds = new Set(after.flatMap((m: any) => (m.role === "assistant" ? m.content.filter((b: any) => b.type === "toolCall").map((b: any) => b.id) : [])));
    assert.ok(after.filter((m: any) => m.role === "toolResult").every((m: any) => callIds.has(m.toolCallId)), "every kept result has its call");
  });
});

test("a second digest in the same request carries the condensed steps forward and keeps the request once", async () => {
  await withDigest(async (calls) => {
    const prompt = "Research each of these:\n1. The largest known prime.\n2. Tokyo population.";
    const step = (i: number) => [toolCall(`c${i}`, "web_search", { query: `query ${i}` }), toolResult(`c${i}`, "web_search", `1. Title ${i}\n   URL: https://e.org/${i}\n   x`)];
    const { session } = realSession([{ role: "user", content: prompt }, ...[0, 1, 2, 3, 4, 5].flatMap(step)]);
    const ctx = { ...uiContext(true, { provider: "llama-cpp", id: "cadre" }).ctx, sessionManager: session };
    const compact = async () => {
      const { compaction } = await calls.handlers["session_before_compact"]({ reason: "threshold", preparation: { tokensBefore: 23_000 } }, ctx);
      session.appendCompaction(compaction.summary, compaction.firstKeptEntryId, 23_000);
      return compaction.summary as string;
    };
    await compact();
    for (const i of [6, 7, 8]) for (const m of step(i)) session.appendMessage({ timestamp: 100 + i, ...m } as any);
    const second = await compact();
    assert.equal(second.split(prompt).length - 1, 1, "the request appears once, verbatim");
    for (let i = 0; i <= 5; i++) assert.match(second, new RegExp(`${i + 1}\\. web_search \\{"query":"query ${i}"\\}`));
    assert.doesNotMatch(second, /query 6/);
  });
});

test("a URL cited only from a failed call gets one corrective step at the end of the run", async () => {
  serveProps({ 8080: 32768, 8081: 16384 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  const bad = "https://www.toukei.metro.tokyo.lg.jp/tnenkan/2024/tn24q3e002.htm";
  const build = (fetchOk: boolean) =>
    realSession([
      { role: "user", content: "Research Tokyo's population and write research.md." },
      toolCall("f1", "web_fetch", { url: bad }),
      { ...toolResult("f1", "web_fetch", fetchOk ? `Population 14,192,184. Source ${bad}` : 'Fetch API error (status 404): {"error": "not found"}'), isError: !fetchOk },
      toolCall("w1", "write", { path: "research.md", content: `| Tokyo | the metropolis | ${bad} |` }),
      toolResult("w1", "write", "Successfully wrote to research.md"),
      answer("Done. research.md is written."),
    ]);
  const settle = (session: SessionManager) => calls.handlers["agent_before_settle"](boundary(session), { ...sessionContext([]), sessionManager: session });
  await calls.handlers["before_agent_start"]({ messageType: "user", prompt: "Research Tokyo's population and write research.md." }, uiContext(true).ctx);
  const { session } = build(false);
  const result = await settle(session);
  assert.equal(result.continue, true);
  const [note] = result.entries;
  assert.deepEqual([note.type, note.customType], ["custom_message", "cadre-sources"]);
  assert.match(note.content, new RegExp(`research\\.md cites ${bad.replace(/[.?]/g, "\\$&")}, which failed to load \\(Fetch API error \\(status 404\\)`));
  assert.match(note.content, /Replace it with a source you retrieved, or say the item was not found\./);
  assert.equal((await settle(session))?.continue, undefined, "only once per run");
  const ok = await settle(build(true).session);
  assert.equal(ok?.continue, undefined, "a URL that also loaded is fine");
});

test("with map, the system message lists the project's files", async () => {
  const saved = process.env.CADRE_OPTS;
  process.env.CADRE_OPTS = "map";
  try {
    serveProps({});
    const { pi, calls } = fakePi();
    await extension(pi as any);
    await calls.handlers["before_agent_start"]({ messageType: "user", prompt: "What does pi_extensions/router.ts do?" }, uiContext(true).ctx);
    const system = { role: "system", content: "Pi system prompt" };
    await calls.handlers["context_with_system"]({ messages: [system] });
    assert.match(system.content, /Project files \(paths relative to the working directory\):/);
    assert.match(system.content, /pi_extensions\/router\.ts/);
  } finally {
    if (saved === undefined) delete process.env.CADRE_OPTS;
    else process.env.CADRE_OPTS = saved;
  }
});

test("with firstsmall, a request starts on the second model and every continuation goes to Spark", async () => {
  const saved = process.env.CADRE_OPTS;
  process.env.CADRE_OPTS = "firstsmall";
  try {
    serveProps({ 8080: 32768, 8081: 16384 });
    const { pi, calls } = fakePi();
    await extension(pi as any);
    const cadre = calls.virtual["llama-cpp/cadre"];
    const { ctx } = uiContext(true);
    const ask = { role: "user", content: "Add a restock_report method to Inventory and test it." };
    assert.equal((await cadre.route({ reason: "user", thinkingLevel: "off", messages: [ask] }, ctx)).model.id, "LiquidAI/LFM3-1.7B-GGUF:Q4_K_M");
    const previous = { model: { id: "LiquidAI/LFM3-1.7B-GGUF:Q4_K_M" }, thinkingLevel: "off" };
    assert.equal((await cadre.route({ reason: "continuation", previous, thinkingLevel: "off", messages: [ask] }, ctx)).model.id, "XHToken/Spark-X2.6-4B-GGUF:Q4_K_M");
  } finally {
    if (saved === undefined) delete process.env.CADRE_OPTS;
    else process.env.CADRE_OPTS = saved;
  }
});

test("with descry, only its navigation tools stay active when descry's extension is installed", async () => {
  const saved = process.env.CADRE_OPTS;
  process.env.CADRE_OPTS = "descry";
  try {
    serveProps({});
    const { pi, calls } = fakePi();
    const descry = ["descry_ensure", "descry_search", "descry_callers", "descry_callees", "descry_context", "descry_quick", "descry_flow", "descry_churn", "descry_index"];
    let active = ["read", "bash", "edit", "write", ...descry];
    Object.assign(pi, { getAllTools: () => active.map((name) => ({ name })), getActiveTools: () => active, setActiveTools: (names: string[]) => (active = names) });
    await extension(pi as any);
    await calls.handlers["session_start"]({ reason: "startup" }, { ...uiContext(true).ctx, hasUI: false });
    assert.deepEqual(active, ["read", "bash", "edit", "write", "descry_search", "descry_callers", "descry_context", "descry_quick", "descry_flow"]);
  } finally {
    if (saved === undefined) delete process.env.CADRE_OPTS;
    else process.env.CADRE_OPTS = saved;
  }
});

test("the system message states today's date, which Pi's own prompt does not", async () => {
  serveProps({});
  const { pi, calls } = fakePi();
  await extension(pi as any);
  const system = { role: "system", content: "Pi system prompt" };
  await calls.handlers["context_with_system"]({ messages: [system] });
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(system.content.includes(`Today's date is ${today}.`), system.content);
});

test("with thinking on, each request gets a thinking budget well below its reply limit", async () => {
  serveProps({ 8080: 32768, 8081: 16384 });
  const { pi, calls } = fakePi();
  await extension(pi as any);
  const request = (kwargs: Record<string, unknown>) => ({
    type: "before_provider_request",
    payload: { model: "XHToken/Spark-X2.6-4B-GGUF:Q4_K_M", messages: [{ role: "user", content: "hi" }], max_tokens: 8192, chat_template_kwargs: kwargs },
  });
  const low = await calls.handlers["before_provider_request"](request({ enable_thinking: true, reasoning_effort: "low" }), uiContext(true).ctx);
  assert.equal(low.thinking_budget_tokens, 1024);
  const high = await calls.handlers["before_provider_request"](request({ enable_thinking: true, reasoning_effort: "high" }), uiContext(true).ctx);
  assert.equal(high.thinking_budget_tokens, 4096);
  const off = await calls.handlers["before_provider_request"](request({ enable_thinking: false }), uiContext(true).ctx);
  assert.equal(off.thinking_budget_tokens, undefined);
});

test("a run whose last reply was cut off with no answer continues with a note, which Pi needs after an assistant message", async () => {
  const saved = process.env.CADRE_OPTS;
  process.env.CADRE_OPTS = "continue";
  try {
    serveProps({ 8080: 32768, 8081: 16384 });
    const { pi, calls } = fakePi();
    await extension(pi as any);
    const cut = { ...toolCall("x", "x", {}), content: [{ type: "thinking", thinking: "deliberating ".repeat(500) }], stopReason: "length" };
    const { session } = realSession([{ role: "user", content: "Research six facts" }, cut]);
    const result = await calls.handlers["agent_before_settle"](boundary(session), { ...sessionContext([]), sessionManager: session });
    assert.equal(result.continue, true);
    assert.deepEqual([result.entries[0].type, result.entries[0].customType], ["custom_message", "cadre-continue"]);
    assert.match(result.entries[0].content, /cut off .* before any answer or tool call/);
  } finally {
    if (saved === undefined) delete process.env.CADRE_OPTS;
    else process.env.CADRE_OPTS = saved;
  }
});

test("an edit that leaves a file unparseable is reported in the same tool result", async () => {
  serveProps({});
  const { pi, calls } = fakePi();
  await extension(pi as any);
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const cwd = mkdtempSync(join(tmpdir(), "cadre-edit-"));
  writeFileSync(join(cwd, "store.py"), 'class A:\n    def release(self):\n        """Releases units.""\n        return 1\n');
  const event = { toolName: "edit", toolCallId: "e1", input: { path: "store.py" }, content: [{ type: "text", text: "Successfully replaced 1 block(s) in store.py." }], details: {}, isError: false };
  const result = await calls.handlers["tool_result"](event, { ...uiContext(true).ctx, cwd });
  assert.match(result.content.at(-1).text, /^\[Syntax check: store\.py no longer parses: SyntaxError: unterminated triple-quoted string literal .*\. Fix it before continuing\.\]$/);
  writeFileSync(join(cwd, "store.py"), "def f():\n    return 1\n");
  assert.equal(await calls.handlers["tool_result"](event, { ...uiContext(true).ctx, cwd }), undefined);
});
