/**
 * Pi extension for the local llama-server models.
 *
 * Commands:
 *   /lfm3-status              backend health, loaded model, and context size
 *   /lfm3-thinking <mode>     auto | off | minimal | low | medium | high
 *
 * In auto mode the thinking level is set per prompt: medium for planning, architecture, and diagnosis, off otherwise.
 * Every request gets short coding rules appended to the system message.
 * The backend URL comes from LLAMA_BASE_URL (set by launchers/pi_lfm3.*).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const THINKING_MODES = ["auto", "off", "minimal", "low", "medium", "high"] as const;
type ThinkingMode = (typeof THINKING_MODES)[number];

const REASONING_PROMPT = /plan|architect|diagnose|root cause/i;

const CODING_RULES = [
  "",
  "### LFM3 CODING RULES:",
  "1. Emit ONLY code inside markdown blocks with exact language tags.",
  "2. Preserve base indentation matching target scope exactly.",
  "3. Never introduce redundant or conflicting local imports inside function bodies.",
  "4. Do not include conversational preambles or post-generation commentary.",
].join("\n");

export default function (pi: ExtensionAPI) {
  const backendUrl = process.env.LLAMA_BASE_URL || "http://127.0.0.1:8080";
  let thinkingMode: ThinkingMode = "auto";

  pi.registerCommand("lfm3-status", {
    description: "Show backend health, loaded model, and thinking mode",
    handler: async (_args, ctx) => {
      const lines = [`Backend:  ${backendUrl}`, `Thinking: ${thinkingMode}`];
      let healthy = false;
      try {
        const t0 = Date.now();
        healthy = (await fetch(`${backendUrl}/health`, { signal: AbortSignal.timeout(3000) })).ok;
        lines.push(`Status:   ${healthy ? "online" : "unhealthy"} (${Date.now() - t0}ms)`);
        const props = await (await fetch(`${backendUrl}/props`, { signal: AbortSignal.timeout(3000) })).json();
        lines.push(`Model:    ${props.model_path?.split("/").pop() ?? "unknown"}`);
        lines.push(`Context:  ${props.default_generation_settings?.n_ctx ?? "unknown"} tokens per slot`);
      } catch (e) {
        lines.push(`Status:   offline (${e instanceof Error ? e.message : e})`);
      }
      ctx.ui.notify(lines.join("\n"), healthy ? "info" : "error");
    },
  });

  pi.registerCommand("lfm3-thinking", {
    description: `Set thinking mode: /lfm3-thinking [${THINKING_MODES.join("|")}]`,
    handler: async (args, ctx) => {
      const mode = (args || "").trim().toLowerCase() as ThinkingMode;
      if (!THINKING_MODES.includes(mode)) {
        ctx.ui.notify(`Usage: /lfm3-thinking [${THINKING_MODES.join("|")}]`, "warning");
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
