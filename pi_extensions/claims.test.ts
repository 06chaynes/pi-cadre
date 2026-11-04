import assert from "node:assert/strict";
import { test } from "node:test";

import { bareUrl, claimsOf, unsupportedClaims } from "./claims.ts";

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

test("a value with a unit, rounded from a source's decimals, is supported (71 °C from 71.2°C), and a wrong one is not", () => {
  const source = "At the summit of Mount Everest, the boiling point of water is approximately 160.1°F (71.2°C).";
  assert.deepEqual(unsupportedClaims("Water boils at roughly 71 °C at the summit of Everest.", [source]), []);
  assert.deepEqual(unsupportedClaims("Water boils at 71.2 °C at the summit of Everest.", [source]), []);
  assert.equal(unsupportedClaims("Water boils at roughly 72 °C at the summit of Everest.", [source]).length, 1);
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

test("line numbers that point into files are positions in the code, not claims", () => {
  assert.deepEqual(values("The loop lives in requests/sessions.py:159-210, and the limit is checked at line 190 (lines 237–243 rebuild auth; see lines 183-188 and 202)."), []);
  assert.deepEqual(values("An airline 747 carries 416 passengers on a file.py-free route."), ["number:747", "number:416"]);
});

test("a write-up's own section numbers, in its headings and where it refers to them, are not claims", () => {
  // A live note named "1.1", "2.2" ... "3.2" of a write-up's headings and cross-references, six of six slots, so the
  // values it should have checked went unnamed.
  const doc = "### 1.1 Login-time application\nRoles apply at login.\n\n### 2.2 No membership\nA user with \"no membership\" (see §2.2) keeps 3.5 roles; section 1.1 explains it.\n## 3 Removal\nThe 2.5% case.";
  assert.deepEqual(values(doc), ["number:3.5", "number:2.5"]);
  // A number in a heading's text, not its section number, is still a claim.
  assert.deepEqual(values("## Results for 2024\nThe 1.1 release shipped."), ["number:2024", "number:1.1"]);
});

test("a quotation keeps the inline code in it, so a quoted doc comment matches its source", () => {
  // The code span was blanked before quotes were read, leaving "Withdraw every grant    's group mappings" to match.
  const answer = 'Its doc comment says: "Withdraw every grant `provider`\'s group mappings made to `user`, whatever the sync mode."';
  const source = "/// Withdraw every grant [`provider`]'s group mappings made to [`user`], whatever the sync mode.";
  assert.deepEqual(unsupportedClaims(answer, [source]), []);
});

test("a line number written with ~ is a position in the code, not a claim", () => {
  assert.deepEqual(values("It is defined in token.rs (line ~647), and called at lines ~12-14."), []);
});

test("a number is supported by a source that writes it with a scale word (9.73 million for 9,730,000)", () => {
  assert.deepEqual(unsupportedClaims("The 23 wards have about 9,730,000 residents.", ["The 23 special wards are home to 9.73 million residents."]), []);
  assert.equal(unsupportedClaims("The 23 wards have about 9,780,000 residents.", ["The 23 special wards are home to 9.73 million residents."]).length, 1);
});

test("a quotation that leaves words out with an ellipsis is matched by its words before the first one", () => {
  const source = "/// Find an active token by access token. Unlike a lookup by id, this computes the blind index first.";
  assert.deepEqual(unsupportedClaims('It says: "Find an active token by access token. ... this computes the blind index."', [source]), []);
  assert.deepEqual(unsupportedClaims('It says: "Find an active token by access token … this computes the blind index."', [source]), []);
  assert.equal(unsupportedClaims('It says: "Find a revoked token by its id ... this computes the blind index."', [source]).length, 1);
});

test("a quotation matches its source whatever dash it writes (60–90 for 60-90)", () => {
  const source = "Sperm whales regularly dive for 60-90 minutes, while most baleen whales stay down for less.";
  assert.deepEqual(unsupportedClaims('WhalePedia: "Sperm whales regularly dive for 60–90 minutes..."', [source]), []);
});

test("a line number after a file path (auth_oidc.rs:1638) is a position in the code, not a claim", () => {
  assert.deepEqual(values("The caller is `settle_role_sync` (mandible/src/routes/auth_oidc.rs:1638), not role.rs:474."), []);
});

test("the false-alarm fixes do not accept wrong values or made-up quotes", () => {
  // A one-digit value does not round from just any decimal nearby.
  assert.equal(unsupportedClaims("Unemployment was 3% in 2023.", ["In 2023 unemployment rose to 4.1%, while inflation eased to 2.6%."]).length, 1);
  assert.equal(unsupportedClaims("The error rate is 0% on the benchmark.", ["The error rate on the benchmark is 0.4%."]).length, 1);
  // Every part of a quotation with an ellipsis must be in the source, not only the part before it.
  const report = "According to the report, GDP grew modestly in March.";
  assert.equal(unsupportedClaims('He wrote: "according to the report ... GDP fell by a record amount in March".', [report]).length, 1);
  // A section number counts only as a heading's own number and where the text cites the section.
  assert.deepEqual(values("## 2.5 Results\n\n| Speedup | 2.5 |"), ["number:2.5"]);
  // "lines near 450" in prose is not a line number; a bare B or M is not billion or million.
  assert.deepEqual(values("The bus lines near 450 stops were cut."), ["number:450"]);
  assert.equal(unsupportedClaims("The file is 200000000000 bytes.", ["The file is 200 B on disk."]).length, 1);
});

test("a value given as typical that its sources state only as a bound or a possibility is unsupported, and says so", () => {
  // The recurring research miss: "Sperm whales can dive for 90+ minutes" became "typically 90 minutes".
  const bound = ["Sperm whales can dive for 90+ minutes, while humpback whales typically dive for 15-30 minutes."];
  const [flagged] = unsupportedClaims("A sperm whale typically holds its breath for 90 minutes on a dive.", bound);
  assert.equal(flagged?.claim.value, "90");
  assert.equal(flagged?.bound, "sources");
  // A source that gives the value as typical supports it; an answer that states its own bound is honest.
  const routine = ["Sperm whales routinely hold their breath for 60 to 90 minutes on a dive."];
  assert.deepEqual(unsupportedClaims("A sperm whale typically holds its breath for 90 minutes on a dive.", routine), []);
  assert.deepEqual(unsupportedClaims("A sperm whale can dive for up to 90 minutes, more than most whales.", bound), []);
  // Any clear source giving it plainly supports it, even beside bounds; an unrelated number elsewhere does not count.
  const mixed = [...bound, "Sperm whales regularly dive for 60-90 minutes, and some dives last up to 2 hours."];
  assert.deepEqual(unsupportedClaims("A sperm whale typically holds its breath for 60–90 minutes on a dive.", mixed), []);
  assert.equal(unsupportedClaims("A sperm whale typically holds its breath for 90 minutes on a dive.", [...bound, "The Pentium ran at 90 MHz for a long time."]).length, 1);
  // Without a typical word the bound reading is the answer's own business.
  assert.deepEqual(unsupportedClaims("Sperm whales dive for 90 minutes or more.", bound), []);
});

test("the typical-versus-bound check names no ordinary phrasing (review cases)", () => {
  const upTo = ["Sperm whale dives can last up to 90 minutes, a record among whales."];
  const plus = ["Sperm whales can dive for 90+ minutes."];
  const none = (answer: string, sources: string[]) => assert.deepEqual(unsupportedClaims(answer, sources).map((u) => u.claim.value), [], answer);
  // A typical word counts only near the number, in its own clause.
  none("Generally, sperm whales dive for 45 minutes, and some dives reach 90 minutes.", upTo);
  none("Usually sperm whales dive 45 minutes; some dives last 90 minutes.", upTo);
  // A source with "can" and a typical word after the number states a typical value.
  none("Sperm whale dives typically last 45 minutes.", ["Sperm whale dives can last 45 minutes on average."]);
  none("The average sperm whale dive is 45 minutes.", ["For sperm whales the average dive can be 45 minutes long."]);
  // The answer's own bound, before or after the number, is honest.
  none("Sperm whales usually dive deep, with dives of 90+ minutes.", plus);
  none("Sperm whale dives usually last 90 minutes or more.", plus);
  none("Sperm whale dives usually last under 90 minutes.", upTo);
  none("- **Typical/recorded dives:** up to **117 to 138 minutes**.", ["Recorded sperm whale dives reach up to 117 to 138 minutes."]);
  // Two-digit values given as typical are checked only for this: not named as plain "appears in no source".
  none("On average each test run took 12 seconds.", ["5 runs completed in 60 seconds total."]);
  none("Sperm whales typically dive for 90 minutes.", ["Sperm whales dive for ninety minutes."]);
  // Arithmetic is no bound; a bound on the line before is not this number's.
  none("Sperm whale dives typically last 45 minutes.", ["A sperm whale dive of 45+15 minutes was logged; dives typically last 45 minutes."]);
  none("Sperm whale dives typically last 45 minutes.", ["Dive data for the max\n45 minutes is a typical sperm whale dive."]);
});

test("the typical-versus-bound check finds the value it is for, wherever the number repeats", () => {
  const plus = ["Sperm whales can dive for 90+ minutes, the record among whales."];
  const repeated = unsupportedClaims("In 1990 studies, sperm whale dives typically lasted 90 minutes.", plus);
  assert.deepEqual(repeated.filter((u) => u.claim.value === "90").map((u) => u.bound), ["sources"]);
  // A table whose item asks for a typical value: a bound given as the answer is named, with that reason.
  const row = "| 3. How long a sperm whale typically holds its breath on a dive | 90+ minutes (dive for 90+ minutes). |";
  assert.deepEqual(unsupportedClaims(row, plus).map((u) => [u.claim.value, u.bound]), [["90", "answer"]]);
});

test("reading two-digit typical values stays linear on a long answer line", () => {
  const line = "on average 45 dives a day, ".repeat(12_000);
  const started = Date.now();
  claimsOf(line);
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
});

test("an answer may group digits with plain spaces", () => {
  assert.deepEqual(values("Light travels at 299 792 458 m/s, in 2024 12 labs agree."), ["number:299792458", "number:2024"]);
});

test("a quote is supported only when a source contains it", () => {
  const answer = 'The notes begin "This is the first release of the linux operating system".';
  assert.equal(unsupportedClaims(answer, ["Notes for linux release 0.01. 0. Contents of this directory"]).length, 1);
  assert.deepEqual(unsupportedClaims(answer, ["…begin: This is the first release of the Linux operating system, and…"]), []);
});

test("an answer that copies a source's run-together power (2136,279,841) reads it as the same one number", () => {
  const source = "The largest known prime number is 2136,279,841 − 1, a number that has 41,024,320 digits when written in the decimal system.";
  assert.deepEqual(unsupportedClaims("| Largest prime | 2136,279,841 − 1 with 41,024,320 decimal digits |", [source]), []);
  assert.deepEqual(values("It has 2136,279,841 parts."), ["number:2136279841"]);
});

test("a quote of a comment or quoted block that spans lines matches across the line markers", () => {
  const answer = 'Its docstring says "Initialize TOTP setup for a user. Generates a new secret and QR code for authenticator app setup."';
  for (const marker of ["///", "//", "#", " *", "--", ">"]) {
    const source = `${marker} Initialize TOTP setup for a user.\n${marker} Generates a new secret and QR code for authenticator app setup.\npub fn init_totp_setup() {}`;
    assert.deepEqual(unsupportedClaims(answer, [source]), [], marker);
  }
});

test("a quoted label of three words or fewer is not a quotation to check", () => {
  // A short label in quotes ("wrong answers believed" for an article title) is the writer's wording, not a quotation.
  assert.deepEqual(values('I could not retrieve the "wrong answers believed" agent study.'), []);
  assert.deepEqual(values('The notes begin "Hello everybody out there using".'), ["quote:Hello everybody out there using"]);
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

test("bareUrl drops trailing punctuation in linear time, which a web page can make long", () => {
  // The earlier pattern backtracked over a long run of URL punctuation from every start: 80,000 dots took 10 s.
  const started = Date.now();
  assert.equal(bareUrl(`http://a${".".repeat(1_000_000)}x`), `http://a${".".repeat(1_000_000)}x`);
  assert.equal(bareUrl(`http://a${".".repeat(1_000_000)}`), "http://a");
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
  assert.equal(bareUrl("https://example.com/a_(b))."), "https://example.com/a_(b");
  assert.equal(bareUrl("https://example.com/page]|*`'\">"), "https://example.com/page");
});

test("reading an answer with a very long word takes linear time", () => {
  // The path pattern could start anywhere inside a word and backtracked over its rest: 40,000 letters took 2.6 s.
  const started = Date.now();
  claimsOf(`The value is 42 ${"a".repeat(200_000)} and see src/app/main.py for it.`);
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
});

test("a quotation matches a source that writes its words as Markdown links", () => {
  // The hands-on run: the model quoted Wikipedia word for word, but the fetched page wrote "[Ruth Chepng'etich](url
  // "title")", so the check named a correct quote and the model spent four minutes re-verifying it.
  const page = "Kenyan athlete [Ruth Chepng'etich](https://en.wikipedia.org/wiki/Ruth_Chepng'etich \"Ruth Chepng'etich\") broke the women's world record with a time of 2:09:56 on October 13, 2024, at the [2024 Chicago Marathon](https://en.wikipedia.org/wiki/2024_Chicago_Marathon), and [Mercury](/wiki/Mercury_(element)) too.";
  const answer = 'Wikipedia states: "Kenyan athlete Ruth Chepng\'etich broke the women\'s world record with a time of 2:09:56 on October 13, 2024."';
  assert.deepEqual(unsupportedClaims(answer, [page]).map((u) => u.claim.value), []);
  assert.equal(unsupportedClaims('It says "Kenyan athlete Ruth Chepngetich ran the race in record time on a cold day."', [page]).length, 1, "a misquote is still named");
  // A quote that holds link-like text itself still matches the source as written (found in review).
  const code = "function run() {\n  return handlers[name](event) || fallback(event, options, context);\n}";
  assert.deepEqual(unsupportedClaims('The file says "return handlers[name](event) || fallback(event, options, context)".', [code]), []);
  const started = Date.now();
  unsupportedClaims('"one two three four five six seven eight"', [`${"[a](".repeat(60_000)} ${"[".repeat(60_000)} ${"](x".repeat(60_000)}`]);
  assert.ok(Date.now() - started < 1500, `${Date.now() - started} ms`);
});
