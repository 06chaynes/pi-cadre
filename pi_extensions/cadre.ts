/**
 * Pi extension for the local llama-server models.
 *
 * Registers the "llama-cpp" provider with Spark-X2.6-4B (port 8080) and LFM3-1.7B (port 8081). Each model's context
 * window is the per-slot context reported by its server's /props at startup, or the launcher default when the server
 * is offline. Thinking levels are sent as chat template kwargs that each model's template accepts.
 *
 * Commands:
 *   /cadre-status              health, model file, and per-slot context of both servers
 *   /cadre-thinking <mode>     auto | off | minimal | low | medium | high
 *
 * In auto mode the thinking level is set per prompt: medium for planning, architecture, diagnosis, debugging, and
 * review, off otherwise. Every request gets short coding rules appended to the system message.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HOST = "127.0.0.1";
const THINKING_ENABLED = { $var: "thinking.enabled" };

const SERVERS = {
  spark: {
    id: "XHToken/Spark-X2.6-4B-GGUF:Q4_K_M",
    name: "Spark-X2.6-4B",
    port: 8080,
    defaultContext: 32768,
    // Spark's template accepts reasoning_effort "low" or "high" only.
    chatTemplateKwargs: { enable_thinking: THINKING_ENABLED, reasoning_effort: { $var: "thinking.effort" } },
    thinkingLevelMap: { minimal: "low", low: "low", medium: "high", high: "high" },
  },
  lfm3: {
    id: "LiquidAI/LFM3-1.7B-GGUF:Q4_K_M",
    name: "LFM3-1.7B",
    port: 8081,
    defaultContext: 2048,
    chatTemplateKwargs: { enable_thinking: THINKING_ENABLED },
    thinkingLevelMap: undefined,
  },
} as const;
type ServerKey = keyof typeof SERVERS;

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

const serverUrl = (key: ServerKey) => `http://${HOST}:${SERVERS[key].port}`;

async function fetchProps(key: ServerKey): Promise<any | undefined> {
  try {
    const res = await fetch(`${serverUrl(key)}/props`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

/** Provider model entries. `contexts` holds the per-slot context of each server that answered. */
export function modelConfigs(contexts: Partial<Record<ServerKey, number>>) {
  return (Object.keys(SERVERS) as ServerKey[]).map((key) => {
    const server = SERVERS[key];
    const window = contexts[key] ?? server.defaultContext;
    return {
      id: server.id,
      name: server.name,
      baseUrl: `${serverUrl(key)}/v1`,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning: true,
      contextWindow: window,
      maxTokens: Math.min(8192, Math.floor(window / 4)),
      compat: { thinkingFormat: "chat-template" as const, chatTemplateKwargs: server.chatTemplateKwargs },
      ...(server.thinkingLevelMap && { thinkingLevelMap: server.thinkingLevelMap }),
    };
  });
}

export default async function (pi: ExtensionAPI) {
  const keys = Object.keys(SERVERS) as ServerKey[];
  const props = await Promise.all(keys.map(fetchProps));
  const contexts = Object.fromEntries(keys.map((key, i) => [key, props[i]?.default_generation_settings?.n_ctx]));
  pi.registerProvider("llama-cpp", {
    name: "llama.cpp (local)",
    api: "openai-completions",
    apiKey: "none",
    models: modelConfigs(contexts) as any,
  });

  let thinkingMode: ThinkingMode = "auto";

  pi.registerCommand("cadre-status", {
    description: "Show health, model file, and per-slot context of both llama-server instances",
    handler: async (_args, ctx) => {
      const lines = [`Thinking: ${thinkingMode}`];
      let online = 0;
      for (const key of keys) {
        const info = await fetchProps(key);
        online += info ? 1 : 0;
        const detail = info
          ? `${info.model_path?.split(/[\\/]/).pop() ?? "unknown model"}, ${info.default_generation_settings?.n_ctx ?? "?"} tokens per slot`
          : "offline";
        lines.push(`${SERVERS[key].name} (${serverUrl(key)}): ${detail}`);
      }
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

  pi.on("before_agent_start", async (event) => {
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
