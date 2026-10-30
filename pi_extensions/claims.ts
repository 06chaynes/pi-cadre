/**
 * Checkable claims in an answer (numbers, quotes, URLs) and which of them no source supports. A number counts as
 * supported only where a source has it near words of the claim's own line or sentence, so a value that appears in a
 * passage about something else does not count.
 */
import { bm25, terms } from "./text.ts";

export interface Claim {
  kind: "number" | "quote" | "url";
  value: string;
  /** The table row, or the sentence, the claim was taken from. */
  context: string;
}

export interface Unsupported {
  claim: Claim;
  /** The source passage closest to the claim's context, if any shares a word with it. */
  passage?: string;
}

const URL = /https?:\/\/[^\s"'<>`|)\]]+/g;
// Digit groups: commas, thin spaces and plain spaces (299 792 458). In answers a plain-space group must start with one
// to three digits, so a year next to a count (2024 12) stays two numbers.
const ANSWER_NUMBER = /(?<![\w.])(?:\d{1,3}(?:[,\u2009\u202f ]\d{3}(?!\d))+|\d+)(?:\.\d+)*/g;
const SOURCE_NUMBER = /(?<![\d.])(?:\d{1,3}(?:[,\u2009\u202f ]\d{3}(?!\d))+|\d+)(?:\.\d+)*/g;
// Code and file paths are the model's own material, not claims about sources.
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
const PATH = /(?:~|\.{1,2})?(?:\/[\w.@%+-]+){2,}|[\w.-]+(?:\/[\w.@%+-]+){2,}/g;
const QUOTE = /["“]([^"”\n]{12,300})["”]/g;
const SCALE = /^\s*(thousand|million|billion|trillion|[kMB]\b)/;
const UNIT_SIGN = /^\s?(%|°)/;
// Fewer words than this near a source number (a passage in another script) and the number alone counts.
const MIN_NEAR_WORDS = 3;
// How far around a number in a source to look for the claim's words.
const NEAR_CHARS = 300;
const PASSAGE_CHARS = 300;
const QUOTE_WORDS = 8;

const bareUrl = (url: string) => url.replace(/[).,;:'"*`>\]|]+$/, "");
const normUrl = (url: string) =>
  bareUrl(url)
    .replace(/^https?:\/\/(www\.|m\.)?/i, "")
    .replace(/\.m\.wikipedia\./i, ".wikipedia.")
    .replace(/\/$/, "")
    .toLowerCase();
const normNumber = (n: string) => n.replace(/[,\u2009\u202f ]/g, "");
const normText = (s: string) => s.replace(/[“”"'’*_`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const blank = (text: string, pattern: RegExp) => text.replace(pattern, (m) => " ".repeat(m.length));
const significant = (n: string) => n.replace(/\D/g, "").replace(/^0+/, "");

/** The table row holding `index`, or the sentence holding it when the line is not a table row. */
function contextAt(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const end = text.indexOf("\n", index);
  const line = text.slice(start, end < 0 ? text.length : end);
  if (line.includes("|")) return line.trim();
  const at = index - start;
  const bounds = [...line.matchAll(/(?<=[.!?])\s+(?=[A-Z"“(])/g)].map((m) => m.index! + m[0].length);
  const from = Math.max(0, ...bounds.filter((b) => b <= at));
  const to = Math.min(line.length, ...bounds.filter((b) => b > at));
  return line.slice(from, to).trim();
}

/** Numbers worth checking (three or more digits, a decimal, or a % or ° value), quotes and URLs, each once. */
export function claimsOf(text: string): Claim[] {
  const out: Claim[] = [];
  const seen = new Set<string>();
  const add = (kind: Claim["kind"], value: string, index: number) => {
    if (seen.has(kind + value)) return;
    seen.add(kind + value);
    out.push({ kind, value, context: contextAt(text, index) });
  };
  const prose = blank(text, CODE);
  const plain = blank(blank(prose, URL), PATH);
  for (const m of plain.matchAll(ANSWER_NUMBER)) {
    const n = normNumber(m[0]);
    const after = plain.slice(m.index! + m[0].length, m.index! + m[0].length + 2);
    if (significant(n).length >= 3 || n.includes(".") || UNIT_SIGN.test(after)) add("number", n, m.index!);
  }
  for (const m of prose.matchAll(QUOTE)) add("quote", m[1].trim(), m.index!);
  for (const m of prose.matchAll(URL)) add("url", bareUrl(m[0]), m.index!);
  return out;
}

/** Whether two words match, counting a shortened form of three or more letters (min, minutes). */
const sameWord = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)));

/** Whether source value `s` is the claimed value `n`, or rounds to it where rounding is plain from the text. */
function sameNumber(n: string, s: string, scaled: boolean): boolean {
  if (n === s) return true;
  // A rounded claim: the source is more precise (has decimals) or the claim names a scale (14.2 million).
  if (!s.includes(".") && !scaled) return false;
  const d = n.includes(".") ? significant(n) : significant(n).replace(/0+$/, "");
  const t = significant(s);
  if (d.length < 3 || t.length <= d.length) return false;
  return String(Math.round(Number(t.slice(0, d.length + 1)) / 10)).padStart(d.length, "0") === d;
}

/**
 * Claims in `answer` that no text in `sources` supports, each with the passage of `evidence` closest to its context.
 * Callers pass every text the answer may draw on as `sources` (tool results, saved originals, the user's messages) and
 * the retrieved material alone as `evidence`.
 */
export function unsupportedClaims(answer: string, sources: readonly string[], evidence: readonly string[] = sources): Unsupported[] {
  const sourceUrls = new Set(sources.flatMap((s) => (s.match(URL) ?? []).map(normUrl)));
  const sourceText = normText(sources.join("\n"));
  const numbers = sources.flatMap((s) => [...s.matchAll(SOURCE_NUMBER)].map((m) => ({ value: normNumber(m[0]), source: s, index: m.index! })));
  const supported = (claim: Claim, rest: string) => {
    if (claim.kind === "url") return sourceUrls.has(normUrl(claim.value));
    if (claim.kind === "quote") return sourceText.includes(normText(claim.value).split(" ").slice(0, QUOTE_WORDS).join(" "));
    const scaled = SCALE.test(rest);
    const words = new Set(terms(claim.context).filter((t) => !/^\d+$/.test(t)));
    return numbers.some(({ value, source, index }) => {
      if (!sameNumber(claim.value, value, scaled)) return false;
      if (!words.size) return true;
      const near = terms(source.slice(Math.max(0, index - NEAR_CHARS), index + NEAR_CHARS)).filter((t) => !/^\d+$/.test(t));
      return near.length < MIN_NEAR_WORDS || near.some((t) => [...words].some((w) => sameWord(w, t)));
    });
  };
  const missing = claimsOf(answer).filter((claim) => !supported(claim, claim.kind === "number" ? after(claim) : ""));
  if (!missing.length) return [];
  const passages = evidence.flatMap((s) => s.split(/\n\s*\n|(?<=[.!?])\s+(?=[A-Z])/)).map((p) => p.trim()).filter(Boolean);
  const index = bm25(passages);
  return missing.map((claim) => {
    const scores = index.score(claim.context);
    let best = -1;
    for (let i = 0; i < scores.length; i++) if (scores[i].score > 0 && (best < 0 || scores[i].score > scores[best].score)) best = i;
    return best < 0 ? { claim } : { claim, passage: passages[best].slice(0, PASSAGE_CHARS) };
  });
}

/** The text after a claimed number in its context, where a scale word such as "million" would be. */
function after(claim: Claim): string {
  const m = [...claim.context.matchAll(ANSWER_NUMBER)].find((x) => normNumber(x[0]) === claim.value);
  return m ? claim.context.slice(m.index! + m[0].length) : "";
}
