import assert from "node:assert/strict";
import { test } from "node:test";

import { claimsOf, unsupportedClaims } from "./claims.ts";

const values = (text: string) => claimsOf(text).map((c) => `${c.kind}:${c.value}`);

test("claimsOf takes numbers worth checking, quotes and URLs, and skips numbers inside URLs and short counters", () => {
  assert.deepEqual(values('| 1. Largest prime | Found in **2024**; it has 41,024,320 digits | https://www.mersenne.org/primes/M136279841.html |'), [
    "number:2024",
    "number:41024320",
    "url:https://www.mersenne.org/primes/M136279841.html",
  ]);
  assert.deepEqual(values("Water boils at about 71 °C, and 12 items took 4 steps."), ["number:71"]);
  assert.deepEqual(values('Linux 0.01 notes begin "Notes for linux release 0.01" in the file.'), ["number:0.01", "quote:Notes for linux release 0.01"]);
});

test("each claim keeps the line or sentence it came from as its context", () => {
  const [claim] = claimsOf("Python appeared in 1991. Tokyo has 14 million people.");
  assert.equal(claim.context, "Python appeared in 1991.");
});

test("a number is supported when a source writes it with other digit grouping", () => {
  const answer = "The speed of light is 299,792,458 m/s.";
  assert.deepEqual(unsupportedClaims(answer, ["The speed of light in vacuum is exactly 299 792 458 m s−1."]), []);
  assert.deepEqual(unsupportedClaims("Tungsten melts at 3,422 °C.", ["Tungsten: melting point 3422°C"]), []);
});

test("a rounded number is supported by a more precise source value, but a year is not supported by a longer number", () => {
  assert.deepEqual(unsupportedClaims("Tokyo has 14.2 million people.", ["Tokyo population: 14,195,730 people as of 2025"]), []);
  assert.deepEqual(unsupportedClaims("Everest is 8,849 m tall.", ["Everest's height is 8,848.86 m"]), []);
  assert.equal(unsupportedClaims("Python was released in 2024.", ["Python release id 20241 notes"]).length, 1);
});

test("a number found only in a passage about something else is unsupported", () => {
  const answer = "Water boils at about 90 °C at the summit of Everest.";
  const unrelated = "RELNOTES-0.01 line 90: notes for linux release 0.01, sources to the kernel";
  assert.deepEqual(unsupportedClaims(answer, [unrelated]).map((u) => u.claim.value), ["90"]);
  assert.deepEqual(unsupportedClaims(answer, ["At the summit water boils near 90 °C in some accounts."]), []);
});

test("a number in a passage written in another script is supported by the number alone", () => {
  const answer = "Tokyo's 23 wards had 9,873,999 people.";
  assert.deepEqual(unsupportedClaims(answer, ["令和6年10月1日現在の東京都の人口は、区部が9,873,999人、市部が4,241,439人"]), []);
});

test("a shortened word in the claim matches its longer form near the source number", () => {
  assert.deepEqual(unsupportedClaims("Recorded: 117 min.", ["A whale surfaced after lasting 117 minutes under water."]), []);
});

test("code spans, code blocks and file paths are not claims", () => {
  assert.deepEqual(values('Call `inv.reserve("a", 3)` and then `available("a") == 2000`.'), []);
  assert.deepEqual(values("```python\nprint(\"hello there, general\")\nlimit = 3000\n```"), []);
  assert.deepEqual(values("Written to /private/tmp/claude-501/365cb2b9-6b94/report.md and ./out/2024/run.txt"), []);
});

test("an answer may group digits with plain spaces", () => {
  assert.deepEqual(values("Light travels at 299 792 458 m/s, in 2024 12 labs agree."), ["number:299792458", "number:2024"]);
});

test("a quote is supported only when a source contains it", () => {
  const answer = 'The notes begin "This is the first release of the linux operating system".';
  assert.equal(unsupportedClaims(answer, ["Notes for linux release 0.01. 0. Contents of this directory"]).length, 1);
  assert.deepEqual(unsupportedClaims(answer, ["…begin: This is the first release of the Linux operating system, and…"]), []);
});

test("a URL is supported only when a source contains it", () => {
  const answer = "Source: https://en.wikipedia.org/wiki/Tokyo";
  assert.equal(unsupportedClaims(answer, ["Source: Tokyo - Wikipedia (https://en.m.wikipedia.org/wiki/Tokyo)"]).length, 0);
  assert.equal(unsupportedClaims(answer, ["Source: https://example.org/tokyo"]).length, 1);
});

test("an unsupported claim comes with the source passage closest to its context", () => {
  const sources = [
    "The Nobel Prize in Physics 2024 went to Hopfield and Hinton.",
    "The first iPhone was released on June 29, 2007 in the United States.",
  ];
  const [u] = unsupportedClaims("The first iPhone was released in 1978.", sources);
  assert.equal(u.claim.value, "1978");
  assert.match(u.passage ?? "", /June 29, 2007/);
});

test("a number found only in results of a search that already guessed it is unsupported, and says so", () => {
  // The iPhone failure: the query carried the guess "1978", and the results that matched it were date-bug pages.
  const answer = "| First iPhone | 1978 |";
  const circular = { text: "My iPhone says it was purchased in 1978; the 1978 date is a placeholder.", guessed: ["1978"] };
  const [u] = unsupportedClaims(answer, [circular]);
  assert.equal(u.claim.value, "1978");
  assert.equal(u.circular, true);
  const independent = "The first iPhone was released in 1978 according to this (wrong) page.";
  assert.deepEqual(unsupportedClaims(answer, [circular, independent]), [], "another source that did not search for it supports it");
});

test("a power written with ^ is supported by a source whose superscript formatting was lost (2^136,279,841 as 2136,279,841)", () => {
  const answer = "The largest known prime is 2^136,279,841 − 1.";
  assert.deepEqual(unsupportedClaims(answer, ["The largest known prime is 2136,279,841 − 1, found by GIMPS."]), []);
  assert.equal(unsupportedClaims("It has 279,841 digits.", ["Prime number 2136,279,841 − 1 found."]).length, 1, "a short tail is not enough");
});
