/**
 * Recovers relevant content that a truncated tool result left out. Pi's read tool shows the first 50 KB of a file and
 * bash shows the last part of long output, each with a note on how to see more. Small models tend to treat what they
 * saw as the whole: in testing, Spark sampled the start and end of a 116 KB file and reported that the answer on line
 * 901 was absent. This module searches the unseen lines for words from the user's request and appends the matches,
 * with line numbers, so the model gets them whether or not it pages.
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_MATCHES = 20;
const MAX_LINE_CHARS = 300;
const STOPWORDS = new Set(
  ("about according all also and answer any are but can could did does each explain file for from get give had has " +
    "have how into its just like not one only our out please read sentence should show some tell than that the " +
    "their them then there they this use using was were what when where which who why will with would you your")
    .split(" "),
);

/** Distinctive words of a request, in order: lowercase letters and digits, three or more characters, no stopwords. */
export function keywords(prompt: string): string[] {
  const words = prompt.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  return [...new Set(words)].filter((word) => !STOPWORDS.has(word));
}

/** Lines of a text file, or undefined when it is missing, unreadable, or larger than `maxBytes`. */
export function readLinesCapped(path: string, maxBytes: number): string[] | undefined {
  try {
    if (statSync(path).size > maxBytes) return undefined;
    return readFileSync(path, "utf8").split("\n");
  } catch {
    return undefined;
  }
}

/**
 * Note to append to a truncated read or bash result, listing unseen lines that contain words from `prompt`, or
 * undefined when there is nothing to add. A line must contain two of the words (one when the request has only one).
 */
export function unseenNote(
  toolName: string,
  input: Record<string, unknown>,
  details: any,
  cwd: string,
  prompt: string,
): string | undefined {
  const truncation = details?.truncation;
  if (!truncation?.truncated) return undefined;
  let path: string;
  let shown: (lines: number) => [number, number];
  if (toolName === "read" && typeof input.path === "string") {
    path = isAbsolute(input.path) ? input.path : join(cwd, input.path);
    const start = Math.max(0, Number(input.offset ?? 1) - 1);
    shown = () => [start, start + truncation.outputLines];
  } else if (toolName === "bash" && typeof details.fullOutputPath === "string") {
    path = details.fullOutputPath;
    shown = (lines) => [lines - truncation.outputLines, lines];
  } else {
    return undefined;
  }

  const words = keywords(prompt);
  const lines = words.length ? readLinesCapped(path, MAX_FILE_BYTES) : undefined;
  if (!lines) return undefined;
  const [from, to] = shown(lines.length);
  const needed = Math.min(2, words.length);
  // A word matches at the start of a word in the line, so "prime" finds "primes" but "and" does not find "candidate".
  const patterns = words.map((word) => new RegExp(`(^|[^a-z0-9])${word}`, "i"));
  const matches = lines
    .map((text, i) => ({ i, text, hits: patterns.filter((pattern) => pattern.test(text)).length }))
    .filter((m) => (m.i < from || m.i >= to) && m.hits >= needed)
    .sort((a, b) => b.hits - a.hits || a.i - b.i)
    .slice(0, MAX_MATCHES)
    .sort((a, b) => a.i - b.i);
  if (!matches.length) return undefined;
  const listed = matches.map((m) => `${m.i + 1}: ${m.text.slice(0, MAX_LINE_CHARS)}`).join("\n");
  return `[Lines outside the part shown above that contain words from the request (${words.join(", ")}):]\n${listed}`;
}
