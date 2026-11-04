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
import { isAbsolute, join, resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { guardReason } from "./guard.ts";
import { researchQuestion, routeRequest } from "./router.ts";
import { listedItems, passages, recall, taskQueries } from "./memory.ts";
import { itemFor, keepBest, rerankScores } from "./rerank.ts";
import { projectMap } from "./projectmap.ts";
import { DescryServer, descryMcpCommand, descrySymbols } from "./descry.ts";
import { guesses, withoutGuesses } from "./text.ts";
import { loadOriginal, pruneOriginals, saveOriginal } from "./originals.ts";
import { conversationText, countTokens, requestTokens } from "./tokens.ts";
import { syntaxError } from "./syntax.ts";
import { unsupportedClaims } from "./claims.ts";
import { shortenHits, shortenText, unseenNote } from "./unseen.ts";
import {
  type Contexts,
  type ServerKey,
  HOST,
  RERANKER,
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
// Passage size for reranking a cleared result (the size the clearing-budget measurement used).
const RERANK_PASSAGE_CHARS = 500;
const EXTRACT_BUDGET_CHARS = 12000;
// Most characters of the project file map in the system message (see projectmap.ts).
const MAP_MAX_CHARS = 2000;
// Room for descry's symbols for the request, listed after the project map.
const SYMBOLS_MAX_CHARS = 1200;

// Recall (see memory.ts): most characters of cleared passages brought back per request, from web tools only. Local
// tools are left out: a file or command output can have changed since, and running the tool again is exact.
const RECALL_MAX_CHARS = 6000;
// When clearing has to run, kept results go down to this share of their room, so clearing (which makes the server
// rebuild the prompt from the first cleared result on) runs less often: 1-2 times per large write-up instead of 5-8.
const CLEAR_TO_SHARE = 0.6;
// Most characters of reasoning kept from earlier steps between clearing events; past it, all but the newest step's go.
const REASONING_KEEP_MAX_CHARS = 12_000;
// Pi's own local tools: their output can go stale (a file edited since it was read), and running them again is exact,
// so their results are never recalled. Every other tool's results can be, whichever extension provides it.
// Files whose text is prose an answer may put claims in; code files are left to the syntax check.
const PROSE_FILE = /\.(md|markdown|txt|rst|adoc|org)$/i;
// The source check names at most this many unsupported claims, each with this much of its line.
const MAX_CLAIMS_NAMED = 6;
const CLAIM_CONTEXT_CHARS = 160;
const LOCAL_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
// Query-like arguments of a web tool, from which guessed numbers are removed before the call runs.
const QUERY_KEYS = ["query", "queries", "q", "search_query", "searchQuery"];

/** Removes from `input`'s query-like fields the numbers that `known` does not contain (see withoutGuesses). */
function cleanQueries(input: Record<string, unknown>, known: string) {
  const clean = (query: string) => withoutGuesses(query, known).replace(/\s{2,}/g, " ").trim();
  for (const key of QUERY_KEYS.filter((k) => k in input)) {
    const value = input[key];
    if (typeof value === "string") input[key] = clean(value);
    else if (Array.isArray(value)) input[key] = value.map((v) => (typeof v === "string" ? clean(v) : v));
  }
}

// The digest condenses the current request's steps before the last KEEP_STEPS, each as its call and a one-line outcome.
const KEEP_STEPS = 3;
const STEP_ARGS_CHARS = 150;
const STEP_OUTCOME_CHARS = 120;
const REQUEST_HEADING = "The current request (verbatim):";
const STEPS_HEADING = "Steps already taken for it (condensed by cadre without a model; their full results stay in the session):";

// Size of the digest of earlier requests, and how much of an older answer it keeps once that size is reached.
const DIGEST_MAX_CHARS = 7000;
const DIGEST_SHORT_ANSWER_CHARS = 200;
// Chat template tokens added around each message, which /tokenize of the joined text does not include.
const TEMPLATE_TOKENS_PER_MESSAGE = 8;
const MAX_SHORTEN_ROUNDS = 4;
// No text runs more than this many characters per token, so a result longer than this many times its budget is cut by
// length before it is counted (a 2.3 MB search result is not sent whole to two tokenizers).
const MAX_CHARS_PER_TOKEN = 6;
// How to see the rest of a shortened result: Pi's own paging tools get specific advice, every other tool the default.
const MORE: Record<string, string> = {
  read: "Read again with offset and limit to see other parts.",
  bash: "Run a narrower command (grep, head, tail, sed -n) to see other parts.",
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

  /** Removes, from query-like arguments, numbers found in no user request or earlier tool result of the session. */
  /**
   * For each tool call in `messages`, by id, what the user said and tools returned before it: the numbers it may carry
   * as known (see withoutGuesses). Later results do not count, so a guess cannot be confirmed by what its own search found.
   */
  const knownByCall = (messages: readonly any[]) => {
    const at = new Map<string, number>();
    let known = "";
    for (const m of messages) {
      if (m?.role === "user" || m?.role === "toolResult") known += "\n" + textOf(m);
      else if (m?.role === "assistant") for (const b of m.content ?? []) if (b.type === "toolCall") at.set(b.id, known.length);
    }
    return (id: string) => known.slice(0, at.get(id) ?? known.length);
  };
  const branchMessages = (ctx: ExtensionContext) => ((ctx.sessionManager?.getBranch() ?? []) as any[]).flatMap((e) => (e.type === "message" ? [e.message] : []));

  const neutralizeQueries = (input: Record<string, unknown>, ctx: ExtensionContext) => {
    cleanQueries(input, knownByCall(branchMessages(ctx))(""));
  };

  /** Tokens in a tool result on the densest tokenizer among the running servers, since either model may read it. */
  const resultTokens = async (text: string) => {
    const online = SERVER_KEYS.filter((key) => contexts[key] !== undefined);
    const counts = await Promise.all((online.length ? online : SERVER_KEYS).map((key) => countTokens(key, text)));
    return Math.max(...counts);
  };

  const offlineServers = () => SERVER_KEYS.filter((key) => contexts[key] === undefined);

  pi.on("session_start", async (event, ctx) => {
    pruneOriginals(resultsDir(), Date.now());
    startDescry(ctx.cwd);
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
    // A search query loses numbers that no request or earlier result contains (the model's guesses): with "1978" in an
    // iPhone query, SearXNG returned pages about a 1978 date bug, and the answer was wrong in 8 of 10 replays, 0 of 10
    // without the guess.
    if (!LOCAL_TOOLS.has(event.toolName)) neutralizeQueries(event.input as Record<string, unknown>, ctx);
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
    // Shortening ranks against the call (its query, path, or command) as well as the request, without numbers the model
    // supplied itself: a guess must not decide which parts of the result stay.
    const known = knownByCall(branchMessages(ctx))(event.toolCallId);
    const query = `${withoutGuesses(JSON.stringify(event.input ?? {}), known)} ${lastPrompt}`;
    const shorten = (chars: number) => shortenHits(text, query, chars) ?? shortenText(text, query, chars, MORE[event.toolName] ?? MORE_DEFAULT);
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
      const sessionId = ctx.sessionManager?.getSessionId();
      if (sessionId && !LOCAL_TOOLS.has(event.toolName)) saveOriginal(resultsDir(), sessionId, event.toolCallId, text);
    }
    return content === event.content ? undefined : { content };
  });

  let continued = false;
  // Steps with a timestamp at or before this lose their reasoning in requests (see withoutEarlierReasoning). A new,
  // resumed or forked session gets a fresh runtime; moving to another branch of this one starts from scratch too.
  let reasoningKeptAfter = 0;
  pi.on("session_tree", async () => {
    reasoningKeptAfter = 0;
  });
  // The project file map for the current prompt (built at its start), or "" when off.
  let map = "";
  // descry's symbols for the current prompt, or "" when descry is not installed or nothing matched.
  let symbols = "";
  // The session's descry MCP server and the directory it serves, when descry-mcp is installed. On a large Rust
  // repository, symbols for the prompt took navigation questions from 33 to 36 of 36 with about half the tool calls.
  let descry: { server: DescryServer; cwd: string } | undefined;
  const startDescry = (cwd: string) => {
    if (descry?.cwd === cwd) return;
    descry?.server.close();
    const bin = descryMcpCommand();
    descry = bin ? { server: DescryServer.start(bin, cwd), cwd } : undefined;
  };
  pi.on("session_shutdown", async () => {
    descry?.server.close();
    descry = undefined;
  });
  // The end-of-run source check runs once per prompt.
  let sourcesChecked = false;
  // Whether this prompt's run was already asked to look its answer up.
  let researchAsked = false;

  // Compaction and branch summaries hold their text in `summary`, other messages in `content`.
  const textOf = (message: any) =>
    typeof message?.summary === "string"
      ? message.summary
      : typeof message?.content === "string"
        ? message.content
        : (message?.content ?? []).flatMap((block: any) => (block.type === "text" ? [block.text] : [])).join("\n");

  pi.on("session_before_compact", async (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER) return undefined;
    if (event.reason === "threshold") {
      const messages = ctx.sessionManager.buildSessionProjection().messages;
      const spark = modelConfigs(contexts).find((model) => model.id === SERVERS.spark.id)!;
      const tokens =
        (await countTokens("spark", conversationText(messages))) + TEMPLATE_TOKENS_PER_MESSAGE * messages.length + SYSTEM_ALLOWANCE;
      if (tokens + spark.maxTokens <= spark.contextWindow) return { cancel: true };
    }
    {
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
    const knownFor = knownByCall(entries.flatMap((projected) => projected.messages as any[]));
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
      const call = withoutGuesses(callArgs.get(message.toolCallId) ?? "", knownFor(message.toolCallId));
      // With a reranker running, the passages that best answer the request item this call serves stay (see
      // rerank.ts); without one, line matching, which keeps the answer more often than the hit-aware shortener here.
      const pieces = passages({ source: "", text }, RERANK_PASSAGE_CHARS).map((p) => p.text);
      const scores = await rerankScores(`http://${HOST}:${RERANKER.port}`, itemFor(call, lastPrompt), pieces);
      const extract = scores
        ? `[${name} result, ${size} characters, cleared from context ${reason}. ` +
          `The passages that best answer the request are kept below; run ${name} again for the rest.]\n` +
          keepBest(pieces, scores, CLEAR_KEEP_CHARS).join("\n")
        : `[${name} result, ${size} characters, cleared from context ${reason}. ` +
          `Its opening and the lines matching its call and the request are kept below; run ${name} again for the rest.]\n` +
          shortenText(text, `${call} ${lastPrompt}`, CLEAR_KEEP_CHARS);
      const content = extractChars + extract.length <= EXTRACT_BUDGET_CHARS ? extract : bare;
      extractChars += content === extract ? extract.length : 0;
      edits.unshift({ type: "context_edit" as const, targetId: id, replacement: { content } });
    }
    return edits;
  };

  // During a task, results the model has read stay in full while they fit resultRoom (half of what Spark's window
  // leaves after the reply and system prompt); older ones are cleared, so a long task does not fill the window with
  // results it has finished with. A fixed 16,384-token cap held a 64k slot's kept results at 16k of ~28k, and large-repo
  // write-ups re-read cleared files until they timed out.
  pi.on("turn_end", async (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER) return undefined;
    const keep = resultRoom();
    const unseen = new Set(event.toolResultEntryIds);
    if (!(await clearResults(event.context.contextEntries, keep, unseen, "to make room")).length) return undefined;
    const edits = await clearResults(event.context.contextEntries, Math.floor(keep * CLEAR_TO_SHARE), unseen, "to make room");
    // The server rebuilds the prompt from the first cleared result on, so earlier steps' reasoning leaves now too.
    const steps = event.context.contextEntries.flatMap((projected: any) => projected.messages).filter((m: any) => m?.role === "assistant");
    reasoningKeptAfter = Math.max(reasoningKeptAfter, ...steps.map((m: any) => m.timestamp ?? 0));
    return edits.length ? { entries: edits } : undefined;
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (event.outcome !== "completed" || ctx.model?.provider !== PROVIDER) return undefined;
    const last = event.context.contextMessages.at(-1) as any;
    const unanswered = last?.role === "toolResult" || (last?.role === "assistant" && !textOf(last).trim());
    if (unanswered && !continued) {
      continued = true;
      // Pi continues after an assistant message only when new context is added, so a cut-off reply gets a note.
      if (last?.role !== "assistant") return { continue: true };
      const content = "[Your last reply was cut off at the length limit before any answer or tool call. Continue the task.]";
      return { continue: true, entries: [{ type: "custom_message" as const, customType: "cadre-continue", content, display: false }] };
    }
    if (unanswered) return undefined;
    if (!researchAsked) {
      researchAsked = true;
      const note = unresearched(ctx);
      if (note) return { continue: true, entries: [{ type: "custom_message" as const, customType: "cadre-research", content: note, display: true }] };
    }
    if (!sourcesChecked) {
      sourcesChecked = true;
      const note = sourceCheck(ctx);
      if (note) return { continue: true, entries: [{ type: "custom_message" as const, customType: "cadre-sources", content: note, display: true }] };
    }
    const edits = await clearResults(event.context.contextEntries, 0, new Set(), "after the answer");
    return edits.length ? { entries: edits } : undefined;
  });

  /**
   * A note for the model when the prompt asks about the world (see researchQuestion), a tool beyond Pi's local ones is
   * available, and the run answered without a single successful result from one: an answer from memory.
   */
  const unresearched = (ctx: ExtensionContext) => {
    if (!researchQuestion(lastPrompt)) return undefined;
    const remote = pi.getActiveTools().filter((name) => !LOCAL_TOOLS.has(name));
    if (!remote.length) return undefined;
    const branch = (ctx.sessionManager.getBranch() as any[]).flatMap((e) => (e.type === "message" ? [e.message] : []));
    const run = branch.slice(branch.findLastIndex((m) => m.role === "user") + 1);
    if (run.some((m) => m.role === "toolResult" && !m.isError && !LOCAL_TOOLS.has(m.toolName))) return undefined;
    return `Research check: this answer was given without any source. Look it up with ${remote.join(", ")}, then answer from what the sources say.`;
  };

  /**
   * A note for the model when its answer, or a prose file it wrote in this run, cites a URL that appears only in failed
   * tool calls, or (with the claims option) holds a number, quote or URL that no source supports. Sources are the user's
   * messages, the system prompt, every result that succeeded, and the saved originals of shortened results. Undefined
   * when everything checks out.
   */
  const sourceCheck = (ctx: ExtensionContext) => {
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
    // What the run produced: prose files written in it, and the final answer.
    const produced: [string, string][] = [];
    for (const m of run) {
      if (m.role !== "assistant") continue;
      for (const call of (m.content ?? []).filter((b: any) => b.type === "toolCall" && (b.name === "write" || b.name === "edit"))) {
        const path = String(call.arguments?.path ?? call.name);
        if (!PROSE_FILE.test(path)) continue;
        const edits = call.name === "write" ? [call.arguments?.content] : (call.arguments?.edits ?? [call.arguments]).map((e: any) => e?.newText);
        produced.push([path.split(/[\\/]/).pop()!, edits.filter((t: unknown) => typeof t === "string").join("\n")]);
      }
    }
    const final = [...run].reverse().find((m) => m.role === "assistant" && textOf(m).trim());
    if (final) produced.push(["your answer", textOf(final)]);
    const lines: string[] = [];
    const named = new Set<string>();
    for (const [where, text] of produced) {
      for (const url of urls(text)) {
        if (!failed.has(url) || read.has(url) || named.has(url)) continue;
        named.add(url);
        lines.push(`${where} cites ${url}, which failed to load (${failed.get(url)}) and appears in no tool result that succeeded.`);
      }
    }
    {
      const sessionId = ctx.sessionManager.getSessionId?.();
      // A result does not support the numbers its own call guessed: that call went looking for them. Guesses are read
      // from the arguments as the call ran: a web tool's query lost its guessed numbers before it ran (the session
      // keeps the model's original), so only guesses left elsewhere, as in a fetched URL, count.
      const knownFor = knownByCall(branch);
      const argsOf = new Map<string, string>();
      const asRun = new Map<string, string>();
      for (const m of branch) {
        if (m.role !== "assistant") continue;
        for (const b of m.content ?? []) {
          if (b.type !== "toolCall") continue;
          const args = { ...(b.arguments ?? {}) };
          argsOf.set(b.id, JSON.stringify(args));
          if (!LOCAL_TOOLS.has(b.name)) cleanQueries(args, knownFor(b.id));
          asRun.set(b.id, JSON.stringify(args));
        }
      }
      const results = branch
        .filter((m) => m.role === "toolResult" && !m.isError)
        .map((m) => ({
          text: (sessionId && loadOriginal(resultsDir(), sessionId, m.toolCallId)) || textOf(m),
          guessed: guesses(asRun.get(m.toolCallId) ?? "", knownFor(m.toolCallId)),
        }));
      // A failed call's error, read with the call that failed (its URL names the site), supports what the answer
      // reports about the failure ("the Britannica URL returns 403").
      const errors = branch
        .filter((m) => m.role === "toolResult" && m.isError && !LOCAL_TOOLS.has(m.toolName))
        .map((m) => `${argsOf.get(m.toolCallId) ?? ""}\n${textOf(m)}`);
      // A page a web call fetched supports its own URL and the absolute form of its relative links ("](/2026/qa-...)").
      // Pi's local tools are left out: a write's arguments are the model's own text.
      const fetched = branch
        .filter((m) => m.role === "toolResult" && !m.isError && !LOCAL_TOOLS.has(m.toolName))
        .flatMap((m) =>
          urls(argsOf.get(m.toolCallId) ?? "").flatMap((page) => {
            const linked = [...textOf(m).matchAll(/\]\((\/[^)\s]*)\)/g)].flatMap((l) => {
              try {
                return [new URL(l[1], page).href];
              } catch {
                return [];
              }
            });
            return [page, ...linked];
          }),
        );
      // Read results carry no line numbers; numbered from the read's offset, they support a line number the answer cites
      // ("its doc comment sits at ~1422") where that line is about the same thing, and not a wrong one.
      const numbered = branch
        .filter((m) => m.role === "toolResult" && !m.isError && m.toolName === "read")
        .map((m) => {
          const offset = Number(JSON.parse(argsOf.get(m.toolCallId) ?? "{}").offset) || 1;
          return textOf(m)
            .split("\n")
            .map((line: string, i: number) => `${offset + i}: ${line}`)
            .join("\n");
        });
      const sources = [ctx.getSystemPrompt?.() ?? "", ...branch.filter((m) => m.role === "user").map(textOf), ...errors, ...results, ...numbered];
      const evidence = results.map((r) => r.text);
      // A line that refers to a listed item by number ("- Item 9: 299,792,458 m/s.", "9. ...") is read with that item's
      // text, so its values are checked against sources about the item rather than flagged for lacking topic words.
      const items = listedItems(lastPrompt);
      const withItems = (text: string) =>
        text
          .split("\n")
          .map((line) => {
            const ref = line.match(/\bitem\s+(\d+)\b/i) ?? line.match(/^\s*(?:[-*]\s*)?\**(\d+)[.)]/);
            const n = Number(ref?.[1]);
            if (!ref || n < 1 || n > items.length) return line;
            // After the reference itself, without its closing full stop, so it stays in the claim's sentence.
            const at = ref.index! + ref[0].length;
            return `${line.slice(0, at)} (${items[n - 1].replace(/[.?!]+\s*$/, "")})${line.slice(at)}`;
          })
          .join("\n");
      for (const [where, text] of produced) {
        for (const { claim, passage, circular } of unsupportedClaims(withItems(text), sources, evidence, fetched)) {
          if (named.has(claim.value) || named.size >= MAX_CLAIMS_NAMED) continue;
          named.add(claim.value);
          const context = claim.context.length > CLAIM_CONTEXT_CHARS ? claim.context.slice(0, CLAIM_CONTEXT_CHARS) + "..." : claim.context;
          const why = circular ? "appears only in results of a search that already contained it, so no source confirms it" : "appears in no source";
          lines.push(`${where}: ${claim.value} (in "${context}") ${why}${passage ? `; closest source passage: "${passage}"` : ""}.`);
        }
      }
    }
    if (!lines.length) return undefined;
    return `Source check:\n- ${lines.join("\n- ")}\nFor each item, correct it from a source, show how it was computed from one, or remove it (say the item was not found if no source has it); for a value only your own search contained, search again without it. Replace a URL that failed with a source you retrieved. Then give the corrected answer.`;
  };

  pi.on("before_agent_start", async (event, ctx) => {
    continued = false;
    sourcesChecked = false;
    researchAsked = false;
    // Runs started by an extension's custom message have no prompt and keep the last one.
    if (event.messageType !== "user" || !event.prompt) return undefined;
    lastPrompt = event.prompt;
    map = projectMap(ctx.cwd, event.prompt, MAP_MAX_CHARS);
    symbols = descry ? await descrySymbols(descry.server, event.prompt, SYMBOLS_MAX_CHARS) : "";
    // Low thinking for every prompt: off, low and high scored 38, 40 and 27 of 42 on research (high failed to finish one
    // run of three, off one write-up of three) and the same on coding; /cadre-thinking picks another level.
    if (thinkingMode === "auto") pi.setThinkingLevel("low");
    return undefined;
  });

  // Before each request to a local model: reasoning of earlier steps leaves (Spark's template renders all of it, so with
  // thinking on it would fill the window step by step), and passages of cleared results that match the task come back
  // (see withRecall). Both change the request only when clearing runs or kept reasoning passes its budget, so between
  // those events each request starts with the previous one and the server reuses its cached prompt: stripping the
  // previous step's reasoning on every request made it rebuild that step and its result each time. The session keeps
  // everything.
  pi.on("context", async (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER) return undefined;
    let messages = withoutEarlierReasoning(event.messages);
    messages = withRecall(messages, ctx) ?? messages;
    return messages === event.messages ? undefined : { messages };
  });

  /**
   * `messages` with thinking removed from steps at or before reasoningKeptAfter (moved when clearing runs); when the
   * reasoning kept after it passes REASONING_KEEP_MAX_CHARS, the mark moves to the step before the newest. The same
   * array if nothing changed.
   */
  const withoutEarlierReasoning = (messages: any[]) => {
    const steps = messages.filter((m) => m.role === "assistant");
    const thinking = (m: any) => (m.content ?? []).reduce((n: number, b: any) => n + (b.type === "thinking" ? String(b.thinking ?? "").length : 0), 0);
    const kept = steps.filter((m) => (m.timestamp ?? 0) > reasoningKeptAfter).reduce((n, m) => n + thinking(m), 0);
    if (kept > REASONING_KEEP_MAX_CHARS && steps.length > 1) reasoningKeptAfter = Math.max(reasoningKeptAfter, steps.at(-2).timestamp ?? 0);
    let changed = false;
    const out = messages.map((m) => {
      if (m.role !== "assistant" || (m.timestamp ?? 0) > reasoningKeptAfter || !m.content?.some((b: any) => b.type === "thinking")) return m;
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
    // Local results come back only while current: a read until its file is edited or written, other command output
    // until any file is. Re-reading is not free for a small model: a write-up on a large repository re-read one file 28
    // times across three compactions and never wrote the document while cleared reads came back as bare markers.
    const argsById = new Map<string, any>();
    for (const m of branch) if (m.role === "assistant") for (const b of m.content ?? []) if (b.type === "toolCall") argsById.set(b.id, b.arguments ?? {});
    const pathOf = (id: string) => {
      const path = argsById.get(id)?.path;
      return typeof path === "string" ? resolve(ctx.cwd ?? ".", path) : undefined;
    };
    const lastChange = new Map<string, number>();
    let lastAnyChange = -1;
    branch.forEach((m: any, i: number) => {
      if (m.role !== "toolResult" || (m.toolName !== "edit" && m.toolName !== "write")) return;
      lastAnyChange = i;
      const path = pathOf(m.toolCallId);
      if (path) lastChange.set(path, i);
    });
    const current = (m: any, i: number) => {
      if (!LOCAL_TOOLS.has(m.toolName)) return true;
      if (m.toolName === "edit" || m.toolName === "write") return false;
      if (m.toolName === "read") return (lastChange.get(pathOf(m.toolCallId) ?? "") ?? -1) < i;
      return lastAnyChange < i;
    };
    // A web result's full text is its saved original when it was shortened, else its text in the session; what is still
    // in context is left out, so only cleared or cut text can come back.
    const sessionId = ctx.sessionManager.getSessionId();
    const cleared = branch.flatMap((m: any, i: number) => {
      if (m.role !== "toolResult" || m.isError || !current(m, i)) return [];
      const full = loadOriginal(resultsDir(), sessionId, m.toolCallId) ?? textOf(m);
      const visible = new Set((shown.get(m.toolCallId) ?? "").split("\n"));
      const text = full.split("\n").filter((line: string) => !visible.has(line)).join("\n");
      return text.trim() ? [{ toolCallId: m.toolCallId, source: calls.get(m.toolCallId) ?? m.toolName, text }] : [];
    });
    if (!cleared.length) return undefined;
    const stored = cleared.map(({ source, text }) => ({ source, text }));
    const task = textOf([...branch].reverse().find((m: any) => m.role === "user") ?? {});
    const found = recall(stored, taskQueries(task), RECALL_MAX_CHARS);
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
      system.content += "\n" + CODING_RULES + "\n\n" + today + (map ? "\n\n" + map : "") + (symbols ? "\n\n" + symbols : "");
    }
  });
}
