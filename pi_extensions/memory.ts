/**
 * Session memory for cleared tool results: their text is split into passages, and before each request the passages
 * that best match the task are brought back, ranked by BM25 in code. What the model keeps does not depend on the model
 * choosing to keep it.
 */

import { terms as words } from "./unseen.ts";

export interface Stored {
  /** The call that produced the text, such as `web_search {"query":"..."}`. */
  source: string;
  text: string;
}

export interface Passage {
  source: string;
  text: string;
  /** Index in the stored list of the text the passage came from. */
  from: number;
}

// BM25 parameters (the usual defaults).
const K1 = 1.2;
const B = 0.75;
// Share of a query's terms a passage must contain to be recalled (at least two): a passage that merely mentions the
// topic is left out rather than recalled as filler.
const MIN_TERM_SHARE = 0.4;
// A run of text shorter than this (a heading, a label) joins the run after it.
const MIN_PASSAGE_CHARS = 120;
// Lines the extension adds to tool results (unseen.ts, cadre.ts); they are not the tool's output.
const ANNOTATION = /^\[(Result shortened from |Lines outside the part shown above |This result can leave context )/;
// A list item in a task: "1. ...", "2) ...", "- ...", "* ...".
const ITEM = /^\s*(?:\d+[.)]|[-*•])\s+(.+)$/;

/** Search terms (see unseen.ts) with a plural "s" removed. */
function terms(text: string): string[] {
  return words(text).map((word) => (word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
}

/**
 * Passages of at most `maxChars`: runs of non-blank lines, a short run joined to the next, split further when a run is
 * longer than the limit. Lines the extension added are left out.
 */
export function passages(stored: Stored, maxChars: number, from = 0): Passage[] {
  const out: Passage[] = [];
  let current = "";
  const flush = (force = false) => {
    if (!force && current.length < MIN_PASSAGE_CHARS) return;
    if (current.trim()) out.push({ source: stored.source, text: current.trim(), from });
    current = "";
  };
  for (const raw of stored.text.split("\n")) {
    if (ANNOTATION.test(raw)) continue;
    if (!raw.trim()) {
      flush();
      continue;
    }
    for (let line = raw; line.length; line = line.slice(maxChars)) {
      const piece = line.slice(0, maxChars);
      if (current.length + piece.length + 1 > maxChars) flush(true);
      current += (current ? "\n" : "") + piece;
    }
  }
  flush(true);
  return out;
}

/** One query per listed item in `task`, or the task and the current step as one query when it lists nothing. */
export function taskQueries(task: string, step: string): string[] {
  const items = task.split("\n").flatMap((line) => line.match(ITEM)?.[1] ?? []);
  return items.length >= 2 ? items : [`${task} ${step}`.trim()];
}

/**
 * The best passage of `stored` for each query in turn, skipping passages already chosen and passages that share fewer
 * than MIN_TERM_SHARE of the query's terms (at least two; one for a one-term query), within `budgetChars` in all.
 */
export function recall(stored: readonly Stored[], queries: readonly string[], budgetChars: number): Passage[] {
  const all = stored.flatMap((s, i) => passages(s, Math.max(200, Math.floor(budgetChars / Math.max(1, queries.length))), i));
  if (!all.length) return [];
  const docs = all.map((p) => terms(p.text));
  const avg = docs.reduce((sum, d) => sum + d.length, 0) / docs.length;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log(1 + (docs.length - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
  const chosen = new Set<number>();
  const out: Passage[] = [];
  let used = 0;
  for (const query of queries) {
    const q = [...new Set(terms(query))];
    if (!q.length) continue;
    const need = Math.min(q.length, Math.max(2, Math.ceil(q.length * MIN_TERM_SHARE)));
    let best = -1;
    let bestScore = 0;
    docs.forEach((d, i) => {
      if (chosen.has(i)) return;
      const counts = new Map<string, number>();
      for (const t of d) counts.set(t, (counts.get(t) ?? 0) + 1);
      if (q.filter((t) => counts.has(t)).length < need) return;
      const score = q.reduce((sum, t) => {
        const f = counts.get(t) ?? 0;
        return sum + (f ? (idf(t) * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.length) / avg)) : 0);
      }, 0);
      if (score > bestScore) [best, bestScore] = [i, score];
    });
    if (best < 0 || used + all[best].text.length > budgetChars) continue;
    chosen.add(best);
    out.push(all[best]);
    used += all[best].text.length;
  }
  return out;
}
