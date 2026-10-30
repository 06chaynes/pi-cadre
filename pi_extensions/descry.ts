/**
 * Code symbols for a request from descry (https://github.com/06chaynes/descry), when it is installed: cadre runs the
 * search itself at the start of a prompt and lists the matches beside the project map, so the model gets name and
 * file:line without choosing a tool. A project without an index is indexed in the background for later prompts.
 */

import { execFile, spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import { keywords } from "./text.ts";

const INDEX_DIR = ".descry_cache";
const HEADING = "Code symbols matching the request (from descry):";
const MAX_RESULTS = 12;
const MAX_TERMS = 12;
// A search loads descry's embedding model; a slow one is skipped rather than holding up the prompt.
const SEARCH_TIMEOUT_MS = 20_000;
// A compact result line: "1. [Met] resolve_redirects | requests/sessions.py:159 (1230t, 6c)".
const RESULT = /^\s*\d+\.\s+\[\w+\]\s+(\S+)\s+\|\s+(\S+)/;

/** The descry executable: DESCRY_BIN, else descry on PATH; undefined when neither is there. */
export function descryCommand(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = [env.DESCRY_BIN, ...(env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "descry"))];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

/**
 * The symbols descry finds for the key words of `prompt` in the project at `cwd`, one "name file:line" per line under a
 * heading, within `maxChars`. Empty when the project has no index, the search fails, or the prompt has no key words.
 */
export async function descrySymbols(bin: string, cwd: string, prompt: string, maxChars: number): Promise<string> {
  const terms = keywords(prompt).slice(0, MAX_TERMS);
  if (!terms.length || !existsSync(join(cwd, INDEX_DIR))) return "";
  let output: string;
  try {
    ({ stdout: output } = await promisify(execFile)(bin, ["search", "--exclude-tests", "--limit", String(MAX_RESULTS), ...terms], {
      cwd,
      encoding: "utf8",
      timeout: SEARCH_TIMEOUT_MS,
    }));
  } catch {
    return "";
  }
  const lines = [HEADING];
  let used = HEADING.length;
  for (const line of output.split("\n")) {
    const m = RESULT.exec(line);
    if (!m) continue;
    // A file result names the file twice ("cookies.py | requests/cookies.py"); the path alone says it.
    const entry = m[2].endsWith(m[1]) ? m[2] : `${m[1]} ${m[2]}`;
    if (used + entry.length + 1 > maxChars) break;
    lines.push(entry);
    used += entry.length + 1;
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

/** Starts `descry ensure` in `cwd` in the background (it indexes or refreshes the project) and returns at once. */
export function startIndex(bin: string, cwd: string): void {
  try {
    spawn(bin, ["ensure"], { cwd, detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  } catch {}
}
