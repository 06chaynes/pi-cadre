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
 * review, off otherwise. Truncated read and bash results get the unseen lines that match the request (see unseen.ts).
 * Every request gets short coding rules appended to the system message.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { guardReason } from "./guard.ts";
import { routeRequest } from "./router.ts";
import { unseenNote } from "./unseen.ts";
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
// Private to the user; a shared temporary directory would let another user redirect the logs.
const LOG_DIR = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi-cadre");
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
      route(request, ctx) {
        const spark = ctx.modelRegistry.find(PROVIDER, SERVERS.spark.id)!;
        const lfm3Ready = (contexts.lfm3 ?? 0) >= LFM3_MIN_CONTEXT;
        const lfm3 = lfm3Ready ? ctx.modelRegistry.find(PROVIDER, SERVERS.lfm3.id) : undefined;
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

  const offlineServers = () => SERVER_KEYS.filter((key) => contexts[key] === undefined);

  pi.on("session_start", async (event, ctx) => {
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
    if (!guardOn) return undefined;
    const reason = guardReason(event.toolName, event.input as Record<string, unknown>, ctx.cwd, homedir());
    return reason === undefined ? undefined : { block: true, reason };
  });

  pi.on("tool_result", async (event, ctx) => {
    const note = unseenNote(event.toolName, event.input, (event as any).details, ctx.cwd, lastPrompt);
    return note === undefined ? undefined : { content: [...event.content, { type: "text" as const, text: note }] };
  });

  pi.on("before_agent_start", async (event) => {
    if (event.prompt) lastPrompt = event.prompt;
    if (thinkingMode === "auto" && event.prompt) {
      pi.setThinkingLevel(REASONING_PROMPT.test(event.prompt) ? "medium" : "off");
    }
  });

  pi.on("context_with_system", async (event) => {
    const system = event.messages?.[0];
    if (system?.role === "system" && typeof system.content === "string") {
      system.content += "\n" + CODING_RULES;
    }
  });
}
