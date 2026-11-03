/**
 * Session memory for cleared tool results: their text is split into passages, and before each request the passages
 * that best match the task are brought back, ranked by BM25 in code. What the model keeps does not depend on the model
 * choosing to keep it.
 */

import { bm25 } from "./text.ts";

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

// Share of a query's terms a passage must contain to be recalled (at least two): a passage that merely mentions the
// topic is left out rather than recalled as filler.
const MIN_TERM_SHARE = 0.4;
// A run of text shorter than this (a heading, a label) joins the run after it.
const MIN_PASSAGE_CHARS = 120;
// Lines the extension adds to tool results (unseen.ts, cadre.ts); they are not the tool's output.
const ANNOTATION = /^\[(Result shortened from |Lines outside the part shown above |This result can leave context )/;
// A list item in a task: "1. ...", "2) ...", "- ...", "* ...".
const ITEM = /^\s*(?:\d+[.)]|[-*•])\s+(.+)$/;

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

// Words a clause needs to be its own query ("Cover" before a colon is not one).
const MIN_CLAUSE_WORDS = 3;

/**
 * One query per listed item in `task`; for a task that lists nothing, one per sentence or clause (split at sentence
 * ends, commas, semicolons and colons); for a task of one clause, the task. One query for a long write-up prompt
 * recalled at most one passage, and only one sharing 40% of all its terms. Queries come from the task alone, not the
 * current step, so recalled passages stay the same between requests and the server can reuse its cached prompt.
 */
export function taskQueries(task: string): string[] {
  const items = task.split("\n").flatMap((line) => line.match(ITEM)?.[1] ?? []);
  if (items.length >= 2) return items;
  const clauses = task
    .split(/(?<=[.?!])\s+/)
    .flatMap((sentence) => sentence.split(/[,;:]\s+/))
    .map((clause) => clause.trim())
    .filter((clause) => clause.split(/\s+/).length >= MIN_CLAUSE_WORDS);
  return clauses.length >= 2 ? clauses : [task.trim()];
}

/**
 * The best passage of `stored` for each query in turn, skipping passages already chosen and passages that share fewer
 * than MIN_TERM_SHARE of the query's terms (at least two; one for a one-term query), within `budgetChars` in all.
 */
export function recall(stored: readonly Stored[], queries: readonly string[], budgetChars: number): Passage[] {
  const all = stored.flatMap((s, i) => passages(s, Math.max(200, Math.floor(budgetChars / Math.max(1, queries.length))), i));
  if (!all.length) return [];
  const index = bm25(all.map((p) => p.text));
  const chosen = new Set<number>();
  const out: Passage[] = [];
  let used = 0;
  for (const query of queries) {
    const q = index.queryTerms(query);
    if (!q.length) continue;
    const need = Math.min(q.length, Math.max(2, Math.ceil(q.length * MIN_TERM_SHARE)));
    let best = -1;
    let bestScore = 0;
    index.score(query).forEach(({ score, matched }, i) => {
      if (chosen.has(i) || matched < need) return;
      if (score > bestScore) [best, bestScore] = [i, score];
    });
    if (best < 0 || used + all[best].text.length > budgetChars) continue;
    chosen.add(best);
    out.push(all[best]);
    used += all[best].text.length;
  }
  return out;
}
