/**
 * Pi extension for the local llama-server models.
 *
 * Registers the "llama-cpp" provider with Spark-X2.6-4B (port 8080) and LFM3-1.7B (port 8081), sized from each
 * server's per-slot context, and the "llama-cpp/cadre" model, which routes each prompt to one of them (see router.ts).
 * Thinking levels are sent as chat template kwargs that each model's template accepts.
 *
 * At startup with a UI, it offers to start servers that are not running and to switch to cadre when another
 * provider's model is selected.
 *
 * Commands:
 *   /cadre-status              health, model file, and per-slot context of both servers
 *   /cadre-start               start the servers that are not running
 *   /cadre-thinking <mode>     auto | off | minimal | low | medium | high
 *   /cadre-guard on|off        path guard (see guard.ts), on by default
 *
 * In auto mode the thinking level is set per prompt: medium for planning, architecture, diagnosis, debugging, and
 * review, off otherwise. Truncated read and bash results get the unseen lines that match the request, and any tool
 * result larger than its share of the room for new results (at most RESULT_MAX_TOKENS), counted on the servers'
 * tokenizers, is shortened to its start plus matching lines (see unseen.ts and tokens.ts). During a task,
 * large results the model has read leave future context, oldest first, once the kept ones pass a budget; once a
 * question is answered, all its large results leave (the transcript keeps them). Threshold compaction is cancelled
 * while the conversation still fits Spark.
 * Every request gets short coding rules appended to the system message.
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { guardReason } from "./guard.ts";
import { routeRequest } from "./router.ts";
import { recall, taskQueries } from "./memory.ts";
import { projectMap } from "./projectmap.ts";
import { namedSymbols } from "./symbols.ts";
import { loadOriginal, pruneOriginals, saveOriginal } from "./originals.ts";
import { conversationText, countTokens, requestTokens } from "./tokens.ts";
import { syntaxError } from "./syntax.ts";
import { shortenSearch, shortenText, unseenNote } from "./unseen.ts";
import {
  type Contexts,
  type ServerKey,
  SERVER_KEYS,
  SERVERS,
  fetchProps,
  modelConfigs,
  probeContexts,
  serverUrl,
  startServer,
  waitForHealth,
} from "./servers.ts";

const PROVIDER = "llama-cpp";
const ROUTER_ID = "cadre";
// Pi's system prompt and tools take about 1,600 tokens; below this LFM3 cannot hold a turn.
const LFM3_MIN_CONTEXT = 8192;
// Most tokens one tool result may take, whatever the window: in a 128k window, 32k-token search results made sessions
// about three times slower than 8k ones, with no more correct answers.
const RESULT_MAX_TOKENS = 8192;
// Pi's system prompt and tool definitions are not in session entries; measured at about 2,700 tokens.
const SYSTEM_ALLOWANCE = 4096;
// Tool results at least this long can leave context. A cleared result keeps an extract of CLEAR_KEEP_CHARS (its
// opening and the lines matching its call and the request) while all extracts fit EXTRACT_BUDGET_CHARS, newest first;
// older ones shrink to a one-line note.
const CLEAR_MIN_CHARS = 2000;
const CLEAR_KEEP_CHARS = 1000;
const EXTRACT_BUDGET_CHARS = 12000;
// Most characters of the project file map in the system message (see projectmap.ts).
const MAP_MAX_CHARS = 2000;
// Most characters of the definitions of names in the request (see symbols.ts), added with the map.
const NAMES_MAX_CHARS = 1500;

// Recall (see memory.ts): most characters of cleared passages brought back per request, from web tools only. Local
// tools are left out: a file or command output can have changed since, and running the tool again is exact.
const RECALL_MAX_CHARS = 6000;
const RECALL_TOOLS = new Set(["web_search", "web_fetch"]);

// The digest condenses the current request's steps before the last KEEP_STEPS, each as its call and a one-line outcome.
const KEEP_STEPS = 3;
const STEP_ARGS_CHARS = 150;
const STEP_OUTCOME_CHARS = 120;
const REQUEST_HEADING = "The current request (verbatim):";
const STEPS_HEADING = "Steps already taken for it (condensed by cadre without a model; their full results stay in the session):";

// Size of the digest of earlier requests, and how much of an older answer it keeps once that size is reached.
const DIGEST_MAX_CHARS = 7000;
const DIGEST_SHORT_ANSWER_CHARS = 200;
// Most tokens of read tool results kept in full during a task; more would slow every request with no gain, as with
// RESULT_MAX_TOKENS.
const KEPT_RESULTS_MAX_TOKENS = 16384;
// Chat template tokens added around each message, which /tokenize of the joined text does not include.
const TEMPLATE_TOKENS_PER_MESSAGE = 8;
const MAX_SHORTEN_ROUNDS = 4;
// No text runs more than this many characters per token, so a result longer than this many times its budget is cut by
// length before it is counted (a 2.3 MB search result is not sent whole to two tokenizers).
const MAX_CHARS_PER_TOKEN = 6;
// Most hits one web_search returns (the default of @ollama/pi-web-search).
const SEARCH_MAX_RESULTS = 5;
// How to see the rest of a shortened result, by tool.
const MORE: Record<string, string> = {
  read: "Read again with offset and limit to see other parts.",
  bash: "Run a narrower command (grep, head, tail, sed -n) to see other parts.",
  web_fetch: "Fetch a more specific page, or search for the part you need.",
};
const MORE_DEFAULT = "Call the tool again with a narrower request to see other parts.";
// Thinking budgets per request, by reasoning effort (never more than half the reply limit).
const THINK_BUDGET_LOW = 1024;
const THINK_BUDGET_HIGH = 4096;
// Tokens left free in a slot beyond the prompt and reply limit.
const SLOT_MARGIN_TOKENS = 64;
// Private to the user; a shared temporary directory would let another user redirect the logs.
const LOG_DIR = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi-cadre");
// Full text of shortened web results (see originals.ts); read from the environment at use, like the state directory.
const resultsDir = () => join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi-cadre", "results");
// The first start of a server may download its model from Hugging Face.
const START_TIMEOUT_MS = 30 * 60 * 1000;

const THINKING_MODES = ["auto", "off", "minimal", "low", "medium", "high"] as const;
type ThinkingMode = (typeof THINKING_MODES)[number];
const REASONING_PROMPT = /plan|architect|diagnose|root cause|debug|investigate|review/i;

const CODING_RULES = [
  "",
  "### CODING RULES:",
  "1. Emit ONLY code inside markdown blocks with exact language tags.",
  "2. Preserve base indentation matching target scope exactly.",
  "3. Never introduce redundant or conflicting local imports inside function bodies.",
  "4. Do not include conversational preambles or post-generation commentary.",
].join("\n");

/** Pairs from an earlier summary: a cadre digest's numbered questions and answers, or the whole text as one pair. */
function digestPairs(summary: string): [string, string][] {
  const body = summary.replace(/^Earlier in this session[^\n]*\n?/, "").replace(/\n?The current request and all work on it follow unchanged\.$/, "");
  const items = body.split(/^\d+\. User asked: /m);
  if (items.length < 2) return [["", body]];
  const pairs: [string, string][] = items[0].trim() ? [["", items[0].trim()]] : [];
  for (const item of items.slice(1)) {
    const [question, ...rest] = item.split("\n   Answer: ");
    pairs.push([question.trim(), rest.join("\n   Answer: ").trim()]);
  }
  return pairs;
}

/**
 * Numbered digest lines within DIGEST_MAX_CHARS: answers are shortened to their opening from the oldest on, then the
 * oldest pairs are dropped, so the newest answers stay verbatim however long the session runs.
 */
function renderDigest(pairs: [string, string][]): string[] {
  const shown = pairs.map(([question, answer]) => [question, answer] as [string, string]);
  const render = (from: number) => {
    const lines = from > 0 ? [`(${from} earlier questions omitted)`] : [];
    let number = shown.slice(0, from).filter(([question]) => question).length;
    shown.slice(from).forEach(([question, answer]) => {
      if (question) lines.push(`${++number}. User asked: ${question}`);
      if (answer) lines.push(question ? `   Answer: ${answer}` : answer);
    });
    return lines;
  };
  const size = (from: number) => render(from).join("\n").length;
  for (let i = 0; i < shown.length - 1 && size(0) > DIGEST_MAX_CHARS; i++) {
    if (shown[i][1].length > DIGEST_SHORT_ANSWER_CHARS) shown[i][1] = shown[i][1].slice(0, DIGEST_SHORT_ANSWER_CHARS) + " [...]";
  }
  let from = 0;
  while (from < shown.length - 1 && size(from) > DIGEST_MAX_CHARS) from++;
  return render(from);
}

export default async function (pi: ExtensionAPI) {
  let contexts: Contexts = await probeContexts();
  let thinkingMode: ThinkingMode = "auto";
  let guardOn = true;
  let lastPrompt = "";

  const register = () => {
    const models = modelConfigs(contexts);
    pi.registerProvider(PROVIDER, { name: "llama.cpp (local)", api: "openai-completions", apiKey: "none", models: models as any });
    pi.registerVirtualModel({
      provider: PROVIDER,
      id: ROUTER_ID,
      name: "cadre (LFM3 for questions and small edits, Spark otherwise)",
      thinkingLevels: ["off", "minimal", "low", "medium", "high"],
      contextWindow: models[0].contextWindow,
      maxTokens: models[0].maxTokens,
      input: ["text"],
      async route(request, ctx) {
        const spark = ctx.modelRegistry.find(PROVIDER, SERVERS.spark.id)!;
        const lfm3Ready = (contexts.lfm3 ?? 0) >= LFM3_MIN_CONTEXT;
        let lfm3 = lfm3Ready ? ctx.modelRegistry.find(PROVIDER, SERVERS.lfm3.id) : undefined;
        if (lfm3) {
          // LFM3 takes the request only if the conversation, counted on its tokenizer, leaves room for its reply.
          const messages = request.messages ?? [];
          const tokens = (await countTokens("lfm3", conversationText(messages))) + TEMPLATE_TOKENS_PER_MESSAGE * messages.length;
          if (tokens > lfm3.contextWindow - lfm3.maxTokens) lfm3 = undefined;
        }
        // EXPERIMENT: "firstsmall" starts each request on the second model and continues on Spark.
        if (OPTS.has("firstsmall")) return { model: request.reason === "user" && lfm3 ? lfm3 : spark, thinkingLevel: request.thinkingLevel } as any;
        return routeRequest(request, { spark, lfm3 }) as any;
      },
    });
  };
  register();

  /** Starts the offline servers, then re-registers with their real contexts once each is healthy. */
  const startOffline = async (ctx: ExtensionContext, offline: ServerKey[]) => {
    for (const key of offline) {
      try {
        const log = await startServer(key, process.env, LOG_DIR);
        ctx.ui.notify(`Starting ${SERVERS[key].name} on ${serverUrl(key)} (log: ${log})`, "info");
      } catch (e) {
        ctx.ui.notify(`Could not start llama-server: ${e instanceof Error ? e.message : e}. Install llama.cpp first.`, "error");
        return;
      }
    }
    for (const key of offline) {
      const ready = await waitForHealth(key, START_TIMEOUT_MS);
      contexts = await probeContexts();
      register();
      ctx.ui.notify(`${SERVERS[key].name} ${ready ? "is ready" : "did not become ready; see its log"}`, ready ? "info" : "error");
    }
  };

  /**
   * Conversation room in Spark's window after the reply and system prompt. Results the model has read keep at most
   * half (see turn_end); new results from one response share the other half.
   */
  const resultRoom = () => {
    const spark = modelConfigs(contexts).find((model) => model.id === SERVERS.spark.id)!;
    return Math.floor((spark.contextWindow - spark.maxTokens - SYSTEM_ALLOWANCE) / 2);
  };
  // Tool calls in the latest assistant response; their results arrive before the model reads any of them.
  let pendingCalls = 1;

  /** Tokens in a tool result on the densest tokenizer among the running servers, since either model may read it. */
  const resultTokens = async (text: string) => {
    const online = SERVER_KEYS.filter((key) => contexts[key] !== undefined);
    const counts = await Promise.all((online.length ? online : SERVER_KEYS).map((key) => countTokens(key, text)));
    return Math.max(...counts);
  };

  const offlineServers = () => SERVER_KEYS.filter((key) => contexts[key] === undefined);

  pi.on("session_start", async (event, ctx) => {
    pruneOriginals(resultsDir(), Date.now());
    if (event.reason !== "startup" || !ctx.hasUI) return;
    contexts = await probeContexts();
    register();
    const offline = offlineServers();
    if (offline.length) {
      const names = offline.map((key) => SERVERS[key].name).join(" and ");
      const start = await ctx.ui.confirm(
        `Start ${names}?`,
        `llama-server is not running for ${names}. Start it in the background? It keeps running after Pi exits, and its first start may download the model from Hugging Face.`,
      );
      if (start) void startOffline(ctx, offline);
    }
    if (ctx.model?.provider !== PROVIDER) {
      const use = await ctx.ui.confirm("Use cadre?", "Switch to llama-cpp/cadre, which routes each prompt to LFM3 or Spark?");
      const router = ctx.modelRegistry.find(PROVIDER, ROUTER_ID);
      if (use && router) await pi.setModel(router);
    }
  });

  pi.registerCommand("cadre-start", {
    description: "Start the llama-server instances that are not running",
    handler: async (_args, ctx) => {
      contexts = await probeContexts();
      const offline = offlineServers();
      if (!offline.length) {
        ctx.ui.notify("Both servers are running.", "info");
        return;
      }
      await startOffline(ctx, offline);
    },
  });

  pi.registerCommand("cadre-status", {
    description: "Show health, model file, and per-slot context of both llama-server instances",
    handler: async (_args, ctx) => {
      const lines = [`Thinking: ${thinkingMode}`, `Path guard: ${guardOn ? "on" : "off"}`];
      let online = 0;
      for (const key of SERVER_KEYS) {
        const info = await fetchProps(key);
        online += info ? 1 : 0;
        const detail = info
          ? `${info.model_path?.split(/[\\/]/).pop() ?? "unknown model"}, ${info.default_generation_settings?.n_ctx ?? "?"} tokens per slot`
          : "offline (/cadre-start)";
        lines.push(`${SERVERS[key].name} (${serverUrl(key)}): ${detail}`);
      }
      const lfm3Routing = (contexts.lfm3 ?? 0) >= LFM3_MIN_CONTEXT ? "on" : `off (needs ${LFM3_MIN_CONTEXT}+ tokens per slot)`;
      lines.push(`cadre routing to LFM3: ${lfm3Routing}`);
      ctx.ui.notify(lines.join("\n"), online ? "info" : "error");
    },
  });

  pi.registerCommand("cadre-thinking", {
    description: `Set thinking mode: /cadre-thinking [${THINKING_MODES.join("|")}]`,
    handler: async (args, ctx) => {
      const mode = (args || "").trim().toLowerCase() as ThinkingMode;
      if (!THINKING_MODES.includes(mode)) {
        ctx.ui.notify(`Usage: /cadre-thinking [${THINKING_MODES.join("|")}]`, "warning");
        return;
      }
      thinkingMode = mode;
      if (mode !== "auto") pi.setThinkingLevel(mode);
      ctx.ui.notify(`Thinking mode: ${mode}`, "info");
    },
  });

  pi.registerCommand("cadre-guard", {
    description: "Turn the path guard on or off: /cadre-guard [on|off]",
    handler: async (args, ctx) => {
      const mode = (args || "").trim().toLowerCase();
      if (mode !== "on" && mode !== "off") {
        ctx.ui.notify(`Path guard is ${guardOn ? "on" : "off"}. Usage: /cadre-guard [on|off]`, "info");
        return;
      }
      guardOn = mode === "on";
      ctx.ui.notify(`Path guard: ${mode}`, guardOn ? "info" : "warning");
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    // More search hits mean more of each to cut away; the tool's own default is enough for a step.
    const input = event.input as Record<string, unknown>;
    if (event.toolName === "web_search" && typeof input.max_results === "number" && input.max_results > SEARCH_MAX_RESULTS) {
      input.max_results = SEARCH_MAX_RESULTS;
    }
    if (!guardOn) return undefined;
    const reason = guardReason(event.toolName, event.input as Record<string, unknown>, ctx.cwd, homedir());
    return reason === undefined ? undefined : { block: true, reason };
  });

  // Pi caps each reply at the window minus its own estimate of the prompt, which trusts the previous response's usage
  // and stays high after results leave context (a Spark reply was cut at 17 tokens with the slot mostly free). The
  // limit is set again from the real prompt, counted by the server that will run it.
  pi.on("before_provider_request", async (event) => {
    const payload = event.payload as Record<string, any>;
    const key = SERVER_KEYS.find((k) => SERVERS[k].id === payload?.model);
    const model = modelConfigs(contexts).find((m) => m.id === payload?.model);
    const field = ["max_completion_tokens", "max_tokens"].find((name) => typeof payload?.[name] === "number");
    if (!key || !model || !field) return undefined;
    const left = model.contextWindow - (await requestTokens(key, payload)) - SLOT_MARGIN_TOKENS;
    const limit = Math.max(1, Math.min(model.maxTokens, left));
    // With thinking on, reasoning gets a budget (llama-server's thinking_budget_tokens) well below the reply limit: in
    // testing, Spark spent a whole 8,192-token reply deliberating and stopped with no answer and no tool call.
    const kwargs = payload.chat_template_kwargs ?? {};
    if (kwargs.enable_thinking !== true) return { ...payload, [field]: limit };
    const budget = Math.min(kwargs.reasoning_effort === "high" ? THINK_BUDGET_HIGH : THINK_BUDGET_LOW, Math.floor(limit / 2));
    return { ...payload, [field]: limit, thinking_budget_tokens: budget };
  });

  pi.on("message_end", async (event) => {
    const message = event.message as any;
    if (message.role === "assistant") pendingCalls = Math.max(1, (message.content ?? []).filter((block: any) => block.type === "toolCall").length);
    return undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    // A file left unparseable by an edit or write is reported in the same result (see syntax.ts).
    const path = (event.input as Record<string, unknown>)?.path;
    if ((event.toolName === "edit" || event.toolName === "write") && !event.isError && typeof path === "string") {
      const error = await syntaxError(isAbsolute(path) ? path : join(ctx.cwd, path));
      if (error) {
        const text = `[Syntax check: ${path} no longer parses: ${error.replace(/\n/g, " ")}. Fix it before continuing.]`;
        return { content: [...event.content, { type: "text" as const, text }] };
      }
      return undefined;
    }
    const note = unseenNote(event.toolName, event.input, (event as any).details, ctx.cwd, lastPrompt);
    let content = note === undefined ? event.content : [...event.content, { type: "text" as const, text: note }];
    const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
    const budget = Math.min(RESULT_MAX_TOKENS, Math.floor(resultRoom() / pendingCalls));
    // Shortening ranks against the call (its query, path, or command) as well as the request.
    const query = `${JSON.stringify(event.input ?? {})} ${lastPrompt}`;
    const shorten = (chars: number) =>
      (event.toolName === "web_search" ? shortenSearch(text, query, chars) : undefined) ??
      shortenText(text, query, chars, MORE[event.toolName] ?? MORE_DEFAULT);
    let short = text;
    let tokens = text.length > budget * MAX_CHARS_PER_TOKEN ? Infinity : await resultTokens(text);
    if (tokens === Infinity) {
      short = shorten(budget * 2);
      tokens = await resultTokens(short);
    }
    // Shorten in proportion to the measured overshoot, then measure again; dense text can need a second round.
    for (let round = 0; round < MAX_SHORTEN_ROUNDS && tokens > budget; round++) {
      short = shorten(Math.floor(short.length * (budget / tokens) * 0.95));
      tokens = await resultTokens(short);
    }
    if (short !== text) {
      content = [...content.filter((block) => block.type !== "text"), { type: "text" as const, text: short }];
      if (OPTS.has("recall") && RECALL_TOOLS.has(event.toolName)) saveOriginal(resultsDir(), ctx.sessionManager.getSessionId(), event.toolCallId, text);
    }
    return content === event.content ? undefined : { content };
  });

  // EXPERIMENT ONLY (removed before release): CADRE_OPTS picks compaction options to compare.
  //   cancel    cancel threshold compaction while the conversation fits Spark
  //   clear     clear answered tool results from future context
  //   digest    write the compaction summary without a model: earlier questions and answers, current turn kept
  //   continue  if a run ends without an answer, continue it once
  //   recall    passages of cleared web results that match the task come back with each request
  //   think     auto thinking defaults to low (high for reasoning prompts) instead of off (medium)
  //   map       the system message lists the project's files and where names in the request are defined
  //   firstsmall each request starts on the second model; continuations go to Spark
  const OPTS = new Set((process.env.CADRE_OPTS ?? "cancel,clear").split(",").filter(Boolean));
  let continued = false;
  // The project file map for the current prompt (built at its start), or "" when off.
  let map = "";
  // The end-of-run source check runs once per prompt.
  let sourcesChecked = false;

  // Compaction and branch summaries hold their text in `summary`, other messages in `content`.
  const textOf = (message: any) =>
    typeof message?.summary === "string"
      ? message.summary
      : typeof message?.content === "string"
        ? message.content
        : (message?.content ?? []).flatMap((block: any) => (block.type === "text" ? [block.text] : [])).join("\n");

  pi.on("session_before_compact", async (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER) return undefined;
    if (OPTS.has("cancel") && event.reason === "threshold") {
      const messages = ctx.sessionManager.buildSessionProjection().messages;
      const spark = modelConfigs(contexts).find((model) => model.id === SERVERS.spark.id)!;
      const tokens =
        (await countTokens("spark", conversationText(messages))) + TEMPLATE_TOKENS_PER_MESSAGE * messages.length + SYSTEM_ALLOWANCE;
      if (tokens + spark.maxTokens <= spark.contextWindow) return { cancel: true };
    }
    if (OPTS.has("digest")) {
      const entries = ctx.sessionManager.buildSessionProjection().entries;
      const isUser = (e: any) => e.sourceEntry.type === "message" && e.messages[0]?.role === "user";
      const current = entries.map(isUser).lastIndexOf(true);
      // The current request comes from the session itself: after an earlier compaction it is no longer in context.
      const branch = ctx.sessionManager.getBranch() as any[];
      const request = textOf([...branch].reverse().find((e) => e.type === "message" && e.message.role === "user")?.message ?? {});
      const steps = entries.slice(current + 1).filter((e: any) => e.sourceEntry.type === "message" && e.messages[0]?.role === "assistant");
      const condense = steps.length > KEEP_STEPS;
      if (!condense && !entries.slice(0, Math.max(current, 0)).some(isUser)) return undefined;
      // Earlier requests as [question, answer] pairs; summaries (a model's, or this digest's) carry forward.
      const pairs: [string, string][] = [];
      const carried: string[] = [];
      // Earlier requests end where the current one starts (or, once it is summarized, at its first remaining step).
      for (const e of entries.slice(0, current >= 0 ? current : entries.indexOf(steps[0]))) {
        for (const message of e.messages) {
          const text = textOf(message).trim();
          if (message.role === "user") pairs.push([text.slice(0, 500), ""]);
          else if (message.role === "assistant" && text && pairs.length) pairs[pairs.length - 1][1] = text.slice(0, 1500);
          else if (message.role !== "assistant" && message.role !== "toolResult" && text) {
            const [earlier, stepBlock] = text.split(STEPS_HEADING);
            if (stepBlock) carried.push(...stepBlock.split("\n").filter((line: string) => /^\d+\. /.test(line)).map((line: string) => line.replace(/^\d+\. /, "")));
            const prior = earlier.split(REQUEST_HEADING)[0].trim();
            if (prior) pairs.push(...digestPairs(prior));
          }
        }
      }
      const lines = pairs.length ? ["Earlier in this session (condensed by cadre without a model; newest answers are verbatim):", ...renderDigest(pairs)] : [];
      if (!condense) {
        lines.push("The current request and all work on it follow unchanged.");
        return { compaction: { summary: lines.join("\n"), firstKeptEntryId: entries[current].sourceEntry.id, tokensBefore: (event.preparation as any).tokensBefore ?? 0 } };
      }
      // Steps before the last KEEP_STEPS: each call and a one-line outcome. Their full results stay in the session.
      const results = new Map<string, any>();
      for (const e of entries) for (const m of e.messages) if (m.role === "toolResult") results.set(m.toolCallId, m);
      const outcome = (call: any) => {
        const result = results.get(call.id);
        if (!result) return "no result";
        const text = textOf(result).trim();
        const first = text.split("\n").find((line: string) => line.trim())?.trim().slice(0, STEP_OUTCOME_CHARS) ?? "";
        if (result.isError) return `error: ${first}`;
        return text.startsWith(`[${call.name} result, `) ? first.replace(/\..*$/, ".]") : first || "empty result";
      };
      for (const e of steps.slice(0, steps.length - KEEP_STEPS)) {
        const message = e.messages[0] as any;
        const calls = (message.content ?? []).filter((b: any) => b.type === "toolCall");
        for (const call of calls) carried.push(`${call.name} ${JSON.stringify(call.arguments ?? {}).slice(0, STEP_ARGS_CHARS)} → ${outcome(call)}`);
        if (!calls.length && textOf(message).trim()) carried.push(`said: ${textOf(message).trim().slice(0, STEP_OUTCOME_CHARS)}`);
      }
      lines.push(REQUEST_HEADING, request, STEPS_HEADING, ...carried.map((line, i) => `${i + 1}. ${line}`));
      lines.push("The most recent steps follow unchanged.");
      return {
        compaction: {
          summary: lines.join("\n"),
          firstKeptEntryId: steps[steps.length - KEEP_STEPS].sourceEntry.id,
          tokensBefore: (event.preparation as any).tokensBefore ?? 0,
        },
      };
    }
    return undefined;
  });

  /** Tokens in a seen tool result, counted once per session entry. */
  const resultTokenCache = new Map<string, number>();
  const seenResultTokens = async (id: string, text: string) => {
    if (!resultTokenCache.has(id)) resultTokenCache.set(id, await resultTokens(text));
    return resultTokenCache.get(id)!;
  };

  /**
   * Context edits that replace large tool results with an extract or a one-line marker, newest first kept in full while their tokens fit
   * `keepTokens`. Results in `unseen` (not yet read by the model) are always kept.
   */
  const clearResults = async (entries: readonly any[], keepTokens: number, unseen: ReadonlySet<string>, reason: string) => {
    const callArgs = new Map<string, string>();
    for (const projected of entries) {
      for (const message of projected.messages as any[]) {
        if (message?.role !== "assistant") continue;
        for (const block of message.content ?? []) if (block.type === "toolCall") callArgs.set(block.id, JSON.stringify(block.arguments ?? {}));
      }
    }
    const edits = [];
    let kept = 0;
    let extractChars = 0;
    for (const projected of [...entries].reverse()) {
      const message = projected.messages[0];
      if (projected.sourceEntry.type !== "message" || message?.role !== "toolResult") continue;
      const id = projected.sourceEntry.id;
      const name = message.toolName;
      const text = textOf(message);
      if (unseen.has(id)) continue;
      const cleared = text.match(new RegExp(`^\\[${name} result, ([\\d,]+) characters, cleared`));
      const size = cleared ? cleared[1] : text.length.toLocaleString("en-US");
      const bare = `[${name} result, ${size} characters, cleared from context. Run ${name} again if it is needed.]`;
      if (cleared) {
        // An earlier extract stays while the extracts fit their budget; past it, it shrinks to the one-line marker.
        if (text === bare) continue;
        if (extractChars + text.length <= EXTRACT_BUDGET_CHARS) extractChars += text.length;
        else edits.unshift({ type: "context_edit" as const, targetId: id, replacement: { content: bare } });
        continue;
      }
      if (text.length < CLEAR_MIN_CHARS) continue;
      const tokens = keepTokens > 0 ? await seenResultTokens(id, text) : Infinity;
      if (kept + tokens <= keepTokens) {
        kept += tokens;
        continue;
      }
      const extract =
        `[${name} result, ${size} characters, cleared from context ${reason}. ` +
        `Its opening and the lines matching its call and the request are kept below; run ${name} again for the rest.]\n` +
        shortenText(text, `${callArgs.get(message.toolCallId) ?? ""} ${lastPrompt}`, CLEAR_KEEP_CHARS);
      const content = extractChars + extract.length <= EXTRACT_BUDGET_CHARS ? extract : bare;
      extractChars += content === extract ? extract.length : 0;
      edits.unshift({ type: "context_edit" as const, targetId: id, replacement: { content } });
    }
    return edits;
  };

  // During a task, results the model has read stay in full while they fit resultRoom (at most
  // KEPT_RESULTS_MAX_TOKENS); older ones are cleared, so a long task does not fill the window with results it has
  // finished with.
  pi.on("turn_end", async (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER) return undefined;
    if (!OPTS.has("clear")) return undefined;
    const keep = Math.min(KEPT_RESULTS_MAX_TOKENS, resultRoom());
    const edits = await clearResults(event.context.contextEntries, keep, new Set(event.toolResultEntryIds), "to make room");
    return edits.length ? { entries: edits } : undefined;
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (event.outcome !== "completed" || ctx.model?.provider !== PROVIDER) return undefined;
    const last = event.context.contextMessages.at(-1) as any;
    const unanswered = last?.role === "toolResult" || (last?.role === "assistant" && !textOf(last).trim());
    if (OPTS.has("continue") && unanswered && !continued) {
      continued = true;
      // Pi continues after an assistant message only when new context is added, so a cut-off reply gets a note.
      if (last?.role !== "assistant") return { continue: true };
      const content = "[Your last reply was cut off at the length limit before any answer or tool call. Continue the task.]";
      return { continue: true, entries: [{ type: "custom_message" as const, customType: "cadre-continue", content, display: false }] };
    }
    if (unanswered) return undefined;
    if (!sourcesChecked) {
      sourcesChecked = true;
      const note = failedSources(ctx);
      if (note) return { continue: true, entries: [{ type: "custom_message" as const, customType: "cadre-sources", content: note, display: true }] };
    }
    if (!OPTS.has("clear")) return undefined;
    const edits = await clearResults(event.context.contextEntries, 0, new Set(), "after the answer");
    return edits.length ? { entries: edits } : undefined;
  });

  /**
   * A note for the model when its answer, or a file it wrote in this run, cites a URL that appears only in failed tool
   * calls and in no result that succeeded: a source it never read. Undefined when every cited URL was read.
   */
  const failedSources = (ctx: ExtensionContext) => {
    const branch = (ctx.sessionManager.getBranch() as any[]).flatMap((e) => (e.type === "message" ? [e.message] : []));
    const start = branch.findLastIndex((m) => m.role === "user");
    const run = branch.slice(start + 1);
    const results = new Map<string, any>();
    for (const m of branch) if (m.role === "toolResult") results.set(m.toolCallId, m);
    const bare = (url: string) => url.replace(/[).,;:'"*`>\]|]+$/, "").replace(/\/$/, "");
    const urls = (text: string) => (text.match(/https?:\/\/[^\s"'<>`|)\]]+/g) ?? []).map(bare);
    const failed = new Map<string, string>();
    const read = new Set<string>();
    for (const m of branch) {
      if (m.role === "toolResult" && !m.isError) for (const url of urls(textOf(m))) read.add(url);
      if (m.role === "user") for (const url of urls(textOf(m))) read.add(url);
      if (m.role !== "assistant") continue;
      for (const call of (m.content ?? []).filter((b: any) => b.type === "toolCall")) {
        const result = results.get(call.id);
        if (!result?.isError) continue;
        const error = textOf(result).split("\n")[0].slice(0, 80);
        for (const url of urls(JSON.stringify(call.arguments ?? {}))) failed.set(url, error);
      }
    }
    // Where each cited URL appears: a file written in this run, or the final answer.
    const cited: [string, string][] = [];
    for (const m of run) {
      if (m.role !== "assistant") continue;
      for (const call of (m.content ?? []).filter((b: any) => b.type === "toolCall" && (b.name === "write" || b.name === "edit"))) {
        for (const url of urls(JSON.stringify(call.arguments ?? {}).replace(/\\n/g, " "))) cited.push([String(call.arguments?.path ?? call.name), url]);
      }
    }
    const final = [...run].reverse().find((m) => m.role === "assistant" && textOf(m).trim());
    for (const url of urls(final ? textOf(final) : "")) cited.push(["your answer", url]);
    const unread = cited.filter(([, url], i) => failed.has(url) && !read.has(url) && cited.findIndex(([, u]) => u === url) === i);
    if (!unread.length) return undefined;
    const lines = unread.map(([where, url]) => `${where.split(/[\\/]/).pop()} cites ${url}, which failed to load (${failed.get(url)}) and appears in no tool result that succeeded.`);
    return `Source check: ${lines.join(" ")} Replace it with a source you retrieved, or say the item was not found.`;
  };

  pi.on("before_agent_start", async (event, ctx) => {
    continued = false;
    sourcesChecked = false;
    // Runs started by an extension's custom message have no prompt and keep the last one.
    if (event.messageType !== "user" || !event.prompt) return undefined;
    lastPrompt = event.prompt;
    map = OPTS.has("map") ? [projectMap(ctx.cwd, event.prompt, MAP_MAX_CHARS), namedSymbols(ctx.cwd, event.prompt, NAMES_MAX_CHARS)].filter(Boolean).join("\n\n") : "";
    if (thinkingMode === "auto") {
      const reasoning = REASONING_PROMPT.test(event.prompt);
      // EXPERIMENT: "think" makes low the default and high the level for reasoning prompts.
      pi.setThinkingLevel(OPTS.has("think") ? (reasoning ? "high" : "low") : reasoning ? "medium" : "off");
    }
    return undefined;
  });

  // Notes are part of the session, not of any one context: before each request, the latest accepted note per topic
  // that compaction removed from context is restored in one message after the compaction summary.
  // Before each request to a local model: reasoning from earlier steps leaves (Spark's template renders all of it, so
  // with thinking on it would fill the window step by step), and passages of cleared web results that match the task
  // come back (see withRecall). The session keeps everything.
  pi.on("context", async (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER) return undefined;
    let messages = withoutEarlierReasoning(event.messages);
    if (OPTS.has("recall")) messages = withRecall(messages, ctx) ?? messages;
    return messages === event.messages ? undefined : { messages };
  });

  /** `messages` with thinking blocks removed from every assistant message but the last; the same array if none had any. */
  const withoutEarlierReasoning = (messages: any[]) => {
    const last = messages.findLastIndex((m) => m.role === "assistant");
    let changed = false;
    const out = messages.map((m, i) => {
      if (m.role !== "assistant" || i === last || !m.content?.some((b: any) => b.type === "thinking")) return m;
      changed = true;
      return { ...m, content: m.content.filter((b: any) => b.type !== "thinking") };
    });
    return changed ? out : messages;
  };

  /**
   * An assistant tool call and its result carrying `text`, for context added by the extension: text that came from tool
   * output stays tool output, never a user turn.
   */
  const toolPair = (name: string, args: Record<string, unknown>, text: string) => {
    const id = `cadre-${name}-${Date.now()}`;
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const call = { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], api: "openai-completions", provider: PROVIDER, model: ROUTER_ID, usage, stopReason: "toolUse", timestamp: Date.now() };
    const result = { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: Date.now() };
    return [call, result] as any[];
  };

  /**
   * `messages` with the passages of cleared web results that best match the task (one query per listed item) restored
   * inside the result each came from, so a passage keeps its place and its standing as tool output. Passages of results
   * that compaction removed go in one recall tool result after the compaction summary. Undefined when nothing matches.
   */
  const withRecall = (messages: any[], ctx: ExtensionContext) => {
    const shown = new Map<string, string>();
    for (const m of messages) if (m.role === "toolResult") shown.set(m.toolCallId, textOf(m));
    const branch = ctx.sessionManager.getBranch().flatMap((entry: any) => (entry.type === "message" ? [entry.message] : []));
    const calls = new Map<string, string>();
    for (const m of branch) {
      if (m.role !== "assistant") continue;
      for (const block of m.content ?? []) if (block.type === "toolCall") calls.set(block.id, `${block.name} ${JSON.stringify(block.arguments ?? {})}`);
    }
    // A web result's full text is its saved original when it was shortened, else its text in the session; what is still
    // in context is left out, so only cleared or cut text can come back.
    const sessionId = ctx.sessionManager.getSessionId();
    const cleared = branch.flatMap((m: any) => {
      if (m.role !== "toolResult" || m.isError || !RECALL_TOOLS.has(m.toolName)) return [];
      const full = loadOriginal(resultsDir(), sessionId, m.toolCallId) ?? textOf(m);
      const visible = new Set((shown.get(m.toolCallId) ?? "").split("\n"));
      const text = full.split("\n").filter((line: string) => !visible.has(line)).join("\n");
      return text.trim() ? [{ toolCallId: m.toolCallId, source: calls.get(m.toolCallId) ?? m.toolName, text }] : [];
    });
    if (!cleared.length) return undefined;
    const stored = cleared.map(({ source, text }) => ({ source, text }));
    const task = textOf([...branch].reverse().find((m: any) => m.role === "user") ?? {});
    const step = [...messages].reverse().find((m: any) => m.role === "assistant");
    const stepText = step ? `${textOf(step)} ${(step.content ?? []).filter((b: any) => b.type === "toolCall").map((b: any) => JSON.stringify(b.arguments)).join(" ")}` : "";
    const found = recall(stored, taskQueries(task, stepText), RECALL_MAX_CHARS);
    if (!found.length) return undefined;
    const byCall = new Map<string, string[]>();
    for (const p of found) {
      const id = cleared[p.from].toolCallId;
      byCall.set(id, [...(byCall.get(id) ?? []), p.text]);
    }
    const out = messages.map((m: any) => {
      const passages = m.role === "toolResult" ? byCall.get(m.toolCallId) : undefined;
      if (!passages) return m;
      byCall.delete(m.toolCallId);
      const text = ["[Passages of this result that match the task, restored after clearing:]", ...passages].join("\n\n");
      return { ...m, content: [...m.content, { type: "text", text }] };
    });
    if (byCall.size) {
      const lost = [...byCall].map(([id, passages]) => `From ${calls.get(id) ?? "an earlier call"}:\n${passages.join("\n\n")}`);
      const text = ["[Passages of earlier results, removed by compaction, that match the task:]", ...lost].join("\n\n");
      const at = out.findIndex((m: any) => m.role !== "compactionSummary" && m.role !== "branchSummary");
      out.splice(at < 0 ? out.length : at, 0, ...toolPair("recall", { reason: "results removed by compaction" }, text));
    }
    return out;
  };

  pi.on("context_with_system", async (event) => {
    const system = event.messages?.[0];
    if (system?.role === "system" && typeof system.content === "string") {
      // Pi's prompt has no date, so "latest" or "this year" otherwise means the model's training cutoff.
      const today = `Today's date is ${new Date().toISOString().slice(0, 10)}.`;
      system.content += "\n" + CODING_RULES + "\n\n" + today + (map ? "\n\n" + map : "");
    }
  });
}
