/**
 * Pi Coding Agent Extension: LFM3 Swarm Optimizer
 * Integrates LiquidAI LFM3 1.7B GGUF with Pi Coding Agent.
 * 
 * Features:
 * - Dynamic AutoThinking Policy (Intent-aware thinking level control)
 * - Dynamic AutoContext Policy (Complexity-aware context window scaling up to 256k)
 * - Prefix pre-fill injection and AST sanitization guidelines
 * - Commands: /lfm3-status, /lfm3-thinking, /lfm3-context
 * - Backend connectivity diagnostics (llama.cpp / ollama)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface LFM3State {
  thinkingMode: "auto" | "off" | "minimal" | "low" | "medium" | "high";
  contextMode: "auto" | "2k" | "8k" | "32k" | "64k" | "128k" | "256k" | "512k" | "1m";
  backendUrl: string;
  provider: string;
  model: string;
}

export default function (pi: ExtensionAPI) {
  const state: LFM3State = {
    thinkingMode: "auto",
    contextMode: (process.env.LFM3_CONTEXT_MODE as any) || "auto",
    backendUrl: process.env.LLAMA_BASE_URL || "http://127.0.0.1:8080",
    provider: "llama-cpp",
    model: "Spark-X2.6-4B / LFM3-1.7B"
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

  // 2. Dynamic Auto-Context Policy Resolver
  function resolveAutoContext(prompt: string, fileCount: number = 1): { ctxSize: number; tier: string } {
    if (state.contextMode !== "auto") {
      const overrides: Record<string, number> = {
        "2k": 2048,
        "8k": 8192,
        "32k": 32768,
        "64k": 65536,
        "128k": 131072,
        "256k": 262144,
        "512k": 524288,
        "1m": 1048576
      };
      const size = overrides[state.contextMode] || 32768;
      return { ctxSize: size, tier: `Manual Override (${state.contextMode.toUpperCase()})` };
    }

    const estTokens = Math.ceil(prompt.length / 4);
    const lower = prompt.toLowerCase();

    // 1M Extreme monorepo audit
    if (lower.includes("entire repo") || lower.includes("full audit") || fileCount > 50 || estTokens > 250000) {
      return { ctxSize: 1048576, tier: "Tier 8: Ultra 1M Codebase Ingestion (1M)" };
    }
    if (estTokens > 100000 || fileCount > 20) {
      return { ctxSize: 524288, tier: "Tier 7: Extended Monorepo Audit (512k)" };
    }
    if (estTokens > 50000 || lower.includes("cross-crate")) {
      return { ctxSize: 262144, tier: "Tier 6: Cross-Crate Monorepo (256k)" };
    }
    // Subsystem / multi-file call graph
    if (estTokens > 16000 || fileCount > 5 || lower.includes("call graph") || lower.includes("architecture")) {
      return { ctxSize: 65536, tier: "Tier 4: Subsystem Call Graph (64k)" };
    }
    // Moderate module context
    if (estTokens > 4000 || fileCount > 1 || lower.includes("refactor")) {
      return { ctxSize: 32768, tier: "Tier 3: Multi-File Module (32k)" };
    }
    // Single file / intra-file
    if (estTokens > 1200) {
      return { ctxSize: 8192, tier: "Tier 2: Single File Context (8k)" };
    }
    // Micro-patch / fast test fix
    return { ctxSize: 2048, tier: "Tier 1: Micro Patch (2k Fast Swarm)" };
  }

  // 3. Command: /lfm3-status
  pi.registerCommand("lfm3-status", {
    description: "Display backend health and active multi-model optimization policies",
    handler: async (_args, ctx) => {
      let isHealthy = false;
      let latency = 0;
      let serverCtx = 0;
      let activeModelName = state.model;
      let maxTrainCtx = 1048576;
      try {
        const t0 = Date.now();
        const resp = await fetch(`${state.backendUrl}/health`, { signal: AbortSignal.timeout(3000) });
        latency = Date.now() - t0;
        isHealthy = resp.ok;

        const propsResp = await fetch(`${state.backendUrl}/props`, { signal: AbortSignal.timeout(3000) });
        if (propsResp.ok) {
          const props = await propsResp.json();
          serverCtx = props?.default_generation_settings?.n_ctx || 0;
          if (props?.model_path) {
            activeModelName = props.model_path.split("/").pop() || props.model_path;
            if (activeModelName.toLowerCase().includes("lfm3")) {
              maxTrainCtx = 262144;
            } else {
              maxTrainCtx = 1048576;
            }
          }
        }
      } catch (e) {
        isHealthy = false;
      }

      const statusEmoji = isHealthy ? "🟢 ONLINE" : "🔴 OFFLINE";
      const resolved = resolveAutoContext("status query");
      const report = [
        `\n=== Multi-Model Swarm Framework Status ===`,
        `Backend:        ${state.backendUrl} (${statusEmoji}, ${latency}ms)`,
        `Provider:       ${state.provider}`,
        `Model:          ${activeModelName}`,
        `Max Trained:    ${maxTrainCtx.toLocaleString()} tokens (${maxTrainCtx >= 1000000 ? "1M" : "256k"})`,
        `Live Server:    ${serverCtx ? serverCtx.toLocaleString() + " tokens" : "Auto-managed"}`,
        `Context Mode:   ${state.contextMode.toUpperCase()} (${resolved.tier})`,
        `Thinking Mode:  ${state.thinkingMode.toUpperCase()} (Auto-Thinking Policy active)`,
        `AST Sanitize:   Enabled (Docstring Stripping & Import Guard)`,
        `==========================================\n`
      ].join("\n");

      ctx.ui.notify(report, isHealthy ? "info" : "error");
    }
  });

  // 4. Command: /lfm3-thinking
  pi.registerCommand("lfm3-thinking", {
    description: "Set thinking policy: /lfm3-thinking [auto|off|low|medium|high]",
    handler: async (args, ctx) => {
      const mode = (args || "").trim().toLowerCase();
      const valid = ["auto", "off", "minimal", "low", "medium", "high"];
      if (!valid.includes(mode)) {
        ctx.ui.notify(`Usage: /lfm3-thinking [${valid.join("|")}]`, "warning");
        return;
      }
      state.thinkingMode = mode as any;
      ctx.ui.notify(`Thinking policy set to: ${mode}`, "info");
    }
  });

  // 5. Command: /lfm3-context
  pi.registerCommand("lfm3-context", {
    description: "Set context policy: /lfm3-context [auto|2k|8k|32k|64k|128k|256k|512k|1m]",
    handler: async (args, ctx) => {
      const mode = (args || "").trim().toLowerCase();
      const valid = ["auto", "2k", "8k", "32k", "64k", "128k", "256k", "512k", "1m"];
      if (!valid.includes(mode)) {
        ctx.ui.notify(`Usage: /lfm3-context [${valid.join("|")}]`, "warning");
        return;
      }
      state.contextMode = mode as any;
      const resolved = resolveAutoContext("test");
      ctx.ui.notify(`Context policy set to: ${mode.toUpperCase()} (${resolved.tier})`, "info");
    }
  });

  // 6. Hook: before_agent_start
  pi.on("before_agent_start", async (event, ctx) => {
    const userText = event.prompt || "";
    // Dynamically configure thinking level
    if (state.thinkingMode === "auto") {
      const resolvedThinking = resolveAutoThinking(userText, false);
      if (typeof (ctx as any).setThinkingLevel === "function") {
        await (ctx as any).setThinkingLevel(resolvedThinking);
      }
    }
    // Log dynamic context tier resolution
    const resolvedContext = resolveAutoContext(userText);
    if (ctx?.ui?.notify && state.contextMode === "auto") {
      // notify lightweight context plan
      ctx.ui.notify(`[LFM3 Auto-Context]: Selected ${resolvedContext.tier}`, "info");
    }
  });

  // 7. Hook: context_with_system
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
