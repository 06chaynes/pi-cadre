/**
 * Text matching shared by the result shortening (unseen.ts) and session recall (memory.ts): search terms of a text,
 * and BM25 ranking of passages against a query.
 */

const STOPWORDS = new Set(
  ("about according all also and answer any are but can could did does each explain file for from get give had has " +
    "have how into its just like not one only our out please read sentence should show some tell than that the " +
    "their them then there they this use using was were what when where which who why will with would you your")
    .split(" "),
);

/**
 * Search terms of a text, in order and lowercased: words of three or more letters and digits, and two-character
 * acronyms written in capitals (ML, AI, 3D), without stopwords.
 */
export function terms(text: string): string[] {
  const words = text.match(/\b[A-Z0-9]*[A-Z][A-Z0-9]*\b|[A-Za-z0-9]+/g) ?? [];
  return words
    .filter((word) => word.length >= 3 || (word.length === 2 && word === word.toUpperCase() && /[A-Z]/.test(word)))
    .map((word) => word.toLowerCase())
    .filter((word) => !STOPWORDS.has(word));
}

/** Distinctive words of a request, in order, each once (see terms). */
export function keywords(prompt: string): string[] {
  return [...new Set(terms(prompt))];
}

// BM25 parameters (the usual defaults).
const K1 = 1.2;
const B = 0.75;

/** Terms for ranking: search terms with a plural "s" removed, so "results" matches "result". */
function rankTerms(text: string): string[] {
  return terms(text).map((word) => (word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
}

/**
 * A BM25 index over `docs`. `score(query)` gives each document's score and how many distinct query terms it contains;
 * `queryTerms(query)` gives the distinct ranking terms of a query.
 */
export function bm25(docs: readonly string[]) {
  const counts = docs.map((d) => {
    const c = new Map<string, number>();
    for (const t of rankTerms(d)) c.set(t, (c.get(t) ?? 0) + 1);
    return c;
  });
  const lengths = counts.map((c) => [...c.values()].reduce((sum, n) => sum + n, 0));
  const avg = lengths.reduce((sum, n) => sum + n, 0) / Math.max(1, docs.length);
  const df = new Map<string, number>();
  for (const c of counts) for (const t of c.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log(1 + (docs.length - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
  const queryTerms = (query: string) => [...new Set(rankTerms(query))];
  const score = (query: string) => {
    const q = queryTerms(query);
    return counts.map((c, i) => {
      let total = 0;
      let matched = 0;
      for (const t of q) {
        const f = c.get(t) ?? 0;
        if (!f) continue;
        matched++;
        total += (idf(t) * f * (K1 + 1)) / (f + K1 * (1 - B + (B * lengths[i]) / (avg || 1)));
      }
      return { score: total, matched };
    });
  };
  return { score, queryTerms };
}

// Numbers of two or more digits (with grouping or decimals): values an answer or a query may carry.
const NUMBER = /(\s?)(\b\d[\d,.]*\d\b|\b\d{2,}\b)/g;

/** The numbers in `text` (as written, digit grouping removed) that `known` does not contain: values the model supplied. */
export function guesses(text: string, known: string): string[] {
  const flat = known.replace(/,/g, "");
  const found = [...text.matchAll(NUMBER)].map((m) => m[2].replace(/,/g, "")).filter((n) => !flat.includes(n));
  return [...new Set(found)];
}

/**
 * `text` without the numbers that `known` (what the user said and tools returned before it was written) does not
 * contain: values the model supplied itself. Used so a search, and the ranking of what results keep, follow what is
 * known rather than the model's guess. Digit grouping is ignored when comparing.
 */
export function withoutGuesses(text: string, known: string): string {
  const flat = known.replace(/,/g, "");
  return text.replace(NUMBER, (match, _space, n: string) => (flat.includes(n.replace(/,/g, "")) ? match : ""));
}
