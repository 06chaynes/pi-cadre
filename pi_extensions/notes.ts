/**
 * Grounding check for the note tool: the numbers, URLs, and quoted passages in a note must appear in a tool result
 * the session has seen, so a note can carry what a source said but nothing the model added.
 */

const URL = /https?:\/\/[^\s"'<>)\]]+/g;
// Quoted passages long enough to be a source's words rather than a label.
const QUOTE = /["“]([^"”]{12,})["”]/g;
// Numbers with at least two digits; separators inside them may differ between note and source.
const NUMBER = /\d[\d,.  ]*\d/g;

const squash = (text: string) => text.toLowerCase().replace(/\s+/g, " ");
const digitsOnly = (text: string) => text.replace(/[,   \s]/g, "");
const bareUrl = (url: string) => url.toLowerCase().replace(/[.,;:]+$/, "").replace(/\/+$/, "");

/** Parts of `note` (numbers, URLs, quotes) that `sources` does not contain, as written in the note. */
export function ungroundedParts(note: string, sources: string): string[] {
  const sourceText = squash(sources);
  const sourceDigits = digitsOnly(sources);
  const missing: string[] = [];
  const urls = note.match(URL) ?? [];
  for (const url of urls) if (!sourceText.includes(bareUrl(url))) missing.push(url);
  for (const [whole, quote] of note.matchAll(QUOTE)) if (!sourceText.includes(squash(quote))) missing.push(whole);
  const prose = note.replace(URL, " ").replace(QUOTE, " ");
  for (const number of prose.match(NUMBER) ?? []) {
    const trimmed = number.replace(/[.,]+$/, "");
    if (!sourceDigits.includes(digitsOnly(trimmed))) missing.push(trimmed);
  }
  return missing;
}
