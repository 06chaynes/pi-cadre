import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { descryCommand, descrySymbols, startIndex } from "./descry.ts";

const SEARCH_OUTPUT = `[755n/2,409e | 0.1h ago]

5 match(es) for 'redirect limit' [hybrid] [exclude_tests, compact]:
1. [Cla] TooManyRedirects | requests/exceptions.py:85 (20t, 1c)
2. [Met] resolve_redirects | requests/sessions.py:159 (1230t, 6c)
3. [Met] should_strip_auth | requests/sessions.py:127 (310t, 6c)
4. [Fil] cookies.py | requests/cookies.py (4640t, 0c)
5. [Met] rebuild_proxies | requests/sessions.py:303 (280t, 2c)

Use \`descry context\` with node ID for details.
`;

/** A fake descry that records its arguments and prints `output` (or fails), and a project dir, indexed or not. */
function setup(indexed: boolean, output = SEARCH_OUTPUT, exit = 0) {
  const dir = mkdtempSync(join(tmpdir(), "cadre-descry-"));
  const bin = join(dir, "descry");
  const log = join(dir, "args.log");
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> '${log}'\ncat <<'EOF'\n${output}\nEOF\nexit ${exit}\n`);
  chmodSync(bin, 0o755);
  const project = join(dir, "project");
  mkdirSync(project);
  if (indexed) mkdirSync(join(project, ".descry_cache"));
  return { bin, log, project, dir };
}

test("descrySymbols lists the matching symbols as name and file:line, searched with the request's key words", async () => {
  const { bin, log, project } = setup(true);
  const symbols = await descrySymbols(bin, project, "Explain where the redirect limit is enforced in this library", 2000);
  assert.equal(
    symbols,
    [
      "Code symbols matching the request (from descry):",
      "TooManyRedirects requests/exceptions.py:85",
      "resolve_redirects requests/sessions.py:159",
      "should_strip_auth requests/sessions.py:127",
      "requests/cookies.py",
      "rebuild_proxies requests/sessions.py:303",
    ].join("\n"),
  );
  assert.match(readFileSync(log, "utf8"), /^search --exclude-tests --limit \d+ redirect limit enforced library$/m);
});

test("descrySymbols stays within its size and gives nothing without an index, on failure, or with no key words", async () => {
  const { bin, project } = setup(true);
  assert.equal((await descrySymbols(bin, project, "redirect limit", 140)).split("\n").length, 3);
  assert.equal(await descrySymbols(bin, setup(false).project, "redirect limit", 2000), "");
  assert.equal(await descrySymbols(setup(true, "boom", 1).bin, project, "redirect limit", 2000), "");
  assert.equal(await descrySymbols(bin, project, "what is this", 2000), "");
});

test("descryCommand finds DESCRY_BIN or descry on PATH", () => {
  const { bin, dir } = setup(true);
  assert.equal(descryCommand({ DESCRY_BIN: bin, PATH: "" }), bin);
  assert.equal(descryCommand({ PATH: `/nonexistent:${dir}` }), bin);
  assert.equal(descryCommand({ PATH: "/nonexistent" }), undefined);
});

test("startIndex runs descry ensure in the project, without waiting", async () => {
  const { bin, log, project } = setup(false, "indexed");
  startIndex(bin, project);
  for (let i = 0; i < 50 && !existsSync(log); i++) await new Promise((r) => setTimeout(r, 20));
  assert.match(readFileSync(log, "utf8"), /^ensure$/m);
});
