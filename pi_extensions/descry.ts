/**
 * Code symbols for a request from descry (https://github.com/06chaynes/descry), when its MCP server is installed.
 * cadre starts descry-mcp once per session (the server loads the graph and embedding model on startup), asks it to
 * index or refresh the project, and at the start of each prompt searches it for the request's key words, listing the
 * matches beside the project map. The model gets name and file:line without choosing a tool: descry's tools are never
 * declared to it. The client speaks MCP's stdio transport (newline-delimited JSON-RPC) directly.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";

import { keywords } from "./text.ts";

const HEADING = "Code symbols matching the request (from descry):";
const MAX_RESULTS = 12;
const MAX_TERMS = 12;
const PROTOCOL_VERSION = "2025-06-18";
// The first search after startup waits for the embedding model (about 9 s on a 4B-model machine); later ones are fast.
const SEARCH_TIMEOUT_MS = 15_000;

/** The descry MCP server executable: DESCRY_MCP_BIN, else descry-mcp on PATH; undefined when neither is there. */
export function descryMcpCommand(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = [env.DESCRY_MCP_BIN, ...(env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "descry-mcp"))];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

/** A running descry-mcp for one project. Calls fail (resolve undefined) once the process is gone. */
export class DescryServer {
  private nextId = 1;
  private readonly pending = new Map<number, (result: any) => void>();
  private readonly ready: Promise<boolean>;
  private readonly child: ChildProcess;

  private constructor(child: ChildProcess) {
    this.child = child;
    child.on("error", () => this.fail());
    child.on("exit", () => this.fail());
    child.stdin?.on("error", () => this.fail());
    createInterface({ input: child.stdout! }).on("line", (line) => this.receive(line));
    this.ready = this.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "pi-cadre", version: "1" } }).then((result) => {
      if (result === undefined) return false;
      this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      return true;
    });
  }

  /** Starts descry-mcp in `cwd` and asks it to index the project, or refresh a stale index, in the background. */
  static start(bin: string, cwd: string): DescryServer {
    const server = new DescryServer(spawn(bin, [], { cwd, stdio: ["pipe", "pipe", "ignore"] }));
    void server.call("descry_ensure", {});
    return server;
  }

  /** A tool's structured result, or undefined on error, timeout, or a stopped server. */
  async call(tool: string, args: Record<string, unknown>, timeoutMs = 0): Promise<any> {
    if (!(await this.ready)) return undefined;
    const result = await this.request("tools/call", { name: tool, arguments: args }, timeoutMs);
    return result && !result.isError ? result.structuredContent : undefined;
  }

  /** Stops the server; safe to call more than once. */
  close(): void {
    this.child.stdin?.end();
    this.child.kill();
  }

  private request(method: string, params: unknown, timeoutMs = 0): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = timeoutMs ? setTimeout(() => this.settle(id, undefined), timeoutMs) : undefined;
      this.pending.set(id, (result) => {
        if (timer) clearTimeout(timer);
        resolve(result);
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private send(message: unknown): void {
    if (this.child.exitCode !== null || !this.child.stdin?.writable) return void setImmediate(() => this.fail());
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private receive(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method !== undefined) {
      // A request from the server (none is expected) is declined so it does not wait on cadre.
      if (message.id !== undefined) this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not supported" } });
      return;
    }
    this.settle(message.id, message.error ? undefined : message.result);
  }

  private settle(id: number, result: any): void {
    const resolve = this.pending.get(id);
    if (!resolve) return;
    this.pending.delete(id);
    resolve(result);
  }

  private fail(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, undefined);
  }
}

/**
 * The symbols descry finds for the key words of `prompt`, one "name file:line" per line under a heading, within
 * `maxChars`. Empty when the prompt has no key words, or the search fails or takes longer than `timeoutMs`.
 */
export async function descrySymbols(server: DescryServer, prompt: string, maxChars: number, timeoutMs = SEARCH_TIMEOUT_MS): Promise<string> {
  const terms = keywords(prompt).slice(0, MAX_TERMS);
  if (!terms.length) return "";
  const found = await server.call("descry_search", { terms, limit: MAX_RESULTS, exclude_tests: true }, timeoutMs);
  const lines = [HEADING];
  let used = HEADING.length;
  for (const r of found?.results ?? []) {
    if (typeof r?.file !== "string") continue;
    // A file result is its path; a symbol is its name and file:line.
    const entry = r.type === "File" || typeof r.name !== "string" ? r.file : `${r.name} ${r.file}${r.line ? `:${r.line}` : ""}`;
    if (used + entry.length + 1 > maxChars) break;
    lines.push(entry);
    used += entry.length + 1;
  }
  return lines.length > 1 ? lines.join("\n") : "";
}
