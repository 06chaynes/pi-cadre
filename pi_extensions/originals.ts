/**
 * Full text of tool results that were shortened before entering context, kept on disk per session so recall
 * (memory.ts) can reach the parts that were cut. Files are private to the user and outside the session transcript.
 */

import { closeSync, constants, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");

/** Saves `text` as the original of `toolCallId` in `sessionId`, unless it is larger than the cap. Errors are ignored. */
export function saveOriginal(root: string, sessionId: string, toolCallId: string, text: string): void {
  if (Buffer.byteLength(text) > MAX_BYTES) return;
  try {
    const dir = join(root, safe(sessionId));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fd = openSync(join(dir, `${safe(toolCallId)}.txt`), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Recall falls back to the text in context.
  }
}

/** The saved original of `toolCallId` in `sessionId`, or undefined. */
export function loadOriginal(root: string, sessionId: string, toolCallId: string): string | undefined {
  try {
    return readFileSync(join(root, safe(sessionId), `${safe(toolCallId)}.txt`), "utf8");
  } catch {
    return undefined;
  }
}

/** Removes sessions whose directory has not changed for a week. */
export function pruneOriginals(root: string, now: number): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const dir = join(root, name);
    try {
      if (now - statSync(dir).mtimeMs > MAX_AGE_MS) rmSync(dir, { recursive: true, force: true });
    } catch {
      // Left for the next prune.
    }
  }
}
