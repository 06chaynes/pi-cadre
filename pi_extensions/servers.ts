/**
 * The two llama-server instances: model facts, health probes, provider model entries, and starting a server with the
 * same arguments as launchers/start_llama_server.* (MODEL=dual defaults).
 */

import { spawn } from "node:child_process";
import { chmodSync, constants, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

export const HOST = "127.0.0.1";
const THINKING_ENABLED = { $var: "thinking.enabled" };

export const SERVERS = {
  spark: {
    id: "XHToken/Spark-X2.6-4B-GGUF:Q4_K_M",
    name: "Spark-X2.6-4B",
    port: 8080,
    ctxSize: 131072,
    parallel: 4,
    modelEnv: "SPARK_MODEL",
    // Spark's template accepts reasoning_effort "low" or "high" only.
    chatTemplateKwargs: { enable_thinking: THINKING_ENABLED, reasoning_effort: { $var: "thinking.effort" } },
    thinkingLevelMap: { minimal: "low", low: "low", medium: "high", high: "high" },
  },
  lfm3: {
    id: "LiquidAI/LFM3-1.7B-GGUF:Q4_K_M",
    name: "LFM3-1.7B",
    port: 8081,
    ctxSize: 65536,
    parallel: 4,
    modelEnv: "LFM3_MODEL",
    chatTemplateKwargs: { enable_thinking: THINKING_ENABLED },
    thinkingLevelMap: undefined,
  },
} as const;
export type ServerKey = keyof typeof SERVERS;
export const SERVER_KEYS = Object.keys(SERVERS) as ServerKey[];
export type Contexts = Partial<Record<ServerKey, number>>;

export const serverUrl = (key: ServerKey) => `http://${HOST}:${SERVERS[key].port}`;
const defaultContext = (key: ServerKey) => SERVERS[key].ctxSize / SERVERS[key].parallel;

/** The server's /props, or undefined when it does not answer. */
export async function fetchProps(key: ServerKey): Promise<any | undefined> {
  try {
    const res = await fetch(`${serverUrl(key)}/props`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

/** Per-slot context of each server that answers. */
export async function probeContexts(): Promise<Contexts> {
  const props = await Promise.all(SERVER_KEYS.map(fetchProps));
  const entries = SERVER_KEYS.map((key, i) => [key, props[i]?.default_generation_settings?.n_ctx]);
  return Object.fromEntries(entries.filter(([, n]) => typeof n === "number"));
}

/** Provider model entries. A server missing from `contexts` gets the per-slot context of the launcher defaults. */
export function modelConfigs(contexts: Contexts) {
  return SERVER_KEYS.map((key) => {
    const server = SERVERS[key];
    const window = contexts[key] ?? defaultContext(key);
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

/** llama-server arguments. SPARK_MODEL or LFM3_MODEL in `env` replaces the model with a .gguf path or Hugging Face ID. */
export function serverArgs(key: ServerKey, env: Record<string, string | undefined>): string[] {
  const server = SERVERS[key];
  const model = env[server.modelEnv] || server.id;
  return [
    ...(model.endsWith(".gguf") ? ["-m", model] : ["-hf", model]),
    "--host", HOST,
    "--port", String(server.port),
    "--ctx-size", String(server.ctxSize),
    "--parallel", String(server.parallel),
    "-ngl", "99",
    "--jinja",
  ];
}

/**
 * Opens `<dir>/pi-cadre-<key>.log` for appending. `dir` is created private to the user (0700) and the file is created
 * 0600 and never opened through a symlink, so another local user cannot redirect the server's output.
 */
export function openLog(dir: string, key: ServerKey): { path: string; fd: number } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, `pi-cadre-${key}.log`);
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);
  return { path, fd: openSync(path, flags, 0o600) };
}

/**
 * Starts llama-server in the background, detached so it outlives Pi, with output in `<logDir>/pi-cadre-<key>.log`.
 * Resolves to the log path, or rejects when llama-server cannot be started (for example, not in PATH).
 */
export function startServer(key: ServerKey, env: Record<string, string | undefined>, logDir: string): Promise<string> {
  const log = openLog(logDir, key);
  const child = spawn("llama-server", serverArgs(key, env), { detached: true, stdio: ["ignore", log.fd, log.fd] });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve(log.path);
    });
  });
}

/** Polls /health until the server is ready. Resolves to whether it became ready within `timeoutMs`. */
export async function waitForHealth(key: ServerKey, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${serverUrl(key)}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}
