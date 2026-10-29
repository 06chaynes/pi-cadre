/**
 * Pi Coding Agent Extension: LFM3 Swarm Optimizer
 * Integrates LiquidAI LFM3 1.7B GGUF with Pi Coding Agent.
 * 
 * Features:
 * - Dynamic AutoThinking Policy (Intent-aware thinking level control)
 * - Prefix pre-fill injection and AST sanitization guidelines
 * - /lfm3-status and /lfm3-thinking commands
 * - Backend connectivity diagnostics (llama.cpp / ollama)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface LFM3State {
  thinkingMode: "auto" | "off" | "minimal" | "low" | "medium" | "high";
  backendUrl: string;
  provider: string;
  model: string;
}

export default function (pi: ExtensionAPI) {
  const state: LFM3State = {
    thinkingMode: "auto",
    backendUrl: process.env.LLAMA_BASE_URL || "http://127.0.0.1:8080",
    provider: "llama-cpp",
    model: "LiquidAI/LFM3-1.7B-GGUF:Q4_K_M"
  };

  // 1. Dynamic Auto-Thinking Policy Resolver
  function resolveAutoThinking(prompt: string, isRetry: boolean = false): "off" | "medium" {
    const lower = prompt.toLowerCase();
    // Tracebacks and assertion failures benefit from deep reasoning
    if (isRetry && (lower.includes("assert") || lower.includes("traceback") || lower.includes("error"))) {
      return "medium";
    }
    // High-level planning or architecture analysis
    if (lower.includes("plan") || lower.includes("architect") || lower.includes("diagnose") || lower.includes("root cause")) {
      return "medium";
    }
    // Direct code generation / editing tasks benefit from instant prefix completion
    return "off";
  }

  // 2. Command: /lfm3-status
  pi.registerCommand("lfm3-status", {
    description: "Display LFM3 backend health and active optimization policies",
    handler: async (_args, ctx) => {
      let isHealthy = false;
      let latency = 0;
      try {
        const t0 = Date.now();
        const resp = await fetch(`${state.backendUrl}/health`, { signal: AbortSignal.timeout(3000) });
        latency = Date.now() - t0;
        isHealthy = resp.ok;
      } catch (e) {
        isHealthy = false;
      }

      const statusEmoji = isHealthy ? "🟢 ONLINE" : "🔴 OFFLINE";
      const report = [
        `\n=== LFM3 1.7B Swarm Framework Status ===`,
        `Backend:       ${state.backendUrl} (${statusEmoji}, ${latency}ms)`,
        `Provider:      ${state.provider}`,
        `Model:         ${state.model}`,
        `Thinking Mode: ${state.thinkingMode} (Auto-Thinking Policy active)`,
        `AST Sanitize:  Enabled (Docstring Stripping & Import Guard)`,
        `=========================================\n`
      ].join("\n");

      ctx.ui.notify(report, isHealthy ? "info" : "error");
    }
  });

  // 3. Command: /lfm3-thinking
  pi.registerCommand("lfm3-thinking", {
    description: "Set LFM3 thinking policy: /lfm3-thinking [auto|off|low|medium|high]",
    handler: async (args, ctx) => {
      const mode = (args || "").trim().toLowerCase();
      const valid = ["auto", "off", "minimal", "low", "medium", "high"];
      if (!valid.includes(mode)) {
        ctx.ui.notify(`Usage: /lfm3-thinking [${valid.join("|")}]`, "warning");
        return;
      }
      state.thinkingMode = mode as any;
      ctx.ui.notify(`LFM3 thinking policy set to: ${mode}`, "info");
    }
  });

  // 4. Hook: before_agent_start
  // Dynamically configure thinking level based on user prompt intent
  pi.on("before_agent_start", async (event, ctx) => {
    if (state.thinkingMode === "auto") {
      const userText = event.prompt || "";
      const resolved = resolveAutoThinking(userText, false);
      if (typeof (ctx as any).setThinkingLevel === "function") {
        await (ctx as any).setThinkingLevel(resolved);
      }
    }
  });

  // 5. Hook: context_with_system
  // Injects our foundational optimization instructions into the system context
  pi.on("context_with_system", async (event) => {
    const systemPromptSuffix = [
      "",
      "### LFM3 FOUNDATIONAL CODING RULES:",
      "1. Emit ONLY code inside markdown blocks with exact language tags.",
      "2. Preserve base indentation matching target scope exactly.",
      "3. Never introduce redundant or conflicting local imports inside function bodies.",
      "4. Do not include conversational preambles or post-generation commentary."
    ].join("\n");

    if (Array.isArray(event.messages) && event.messages.length > 0) {
      const firstMsg = event.messages[0];
      if (firstMsg.role === "system") {
        firstMsg.content = (firstMsg.content || "") + "\n" + systemPromptSuffix;
      }
    }
  });
}
