import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { namedSymbols, requestNames } from "./symbols.ts";

function project(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "cadre-sym-"));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

test("requestNames takes backticked identifiers, splitting dotted ones", () => {
  assert.deepEqual(requestNames("Add a doc comment to `release` in src/inventory.ts and check `Inventory.available`."), ["release", "Inventory", "available"]);
  assert.deepEqual(requestNames("Run `python3 -m pytest -q`"), []);
});

test("a named method is located in TypeScript, Python, and Rust", () => {
  const dir = project({
    "src/inventory.ts": "export class Inventory {\n  add(sku: string, qty: number): void {}\n\n  release(sku: string, qty: number): void {\n  }\n}\n",
    "inventory/store.py": "class Inventory:\n    def release(self, sku, qty):\n        pass\n",
    "src/lib.rs": "impl Inventory {\n    pub fn release(&mut self, sku: &str, qty: i64) {}\n}\n",
    "README.md": "release notes: release(x) is documented here\n",
  });
  const out = namedSymbols(dir, "Add a one-line doc comment to `release`.", 2000);
  assert.match(out, /^Names in the request, where they are defined:\n/);
  assert.match(out, /^`release`: /m);
  assert.match(out, /src\/inventory\.ts:4: release\(sku: string, qty: number\): void \{/);
  assert.match(out, /inventory\/store\.py:2: def release\(self, sku, qty\):/);
  assert.match(out, /src\/lib\.rs:2: pub fn release\(&mut self, sku: &str, qty: i64\) \{\}/);
  assert.doesNotMatch(out, /README/);
});

test("names that are not defined in the project add nothing", () => {
  const dir = project({ "a.py": "def other():\n    pass\n" });
  assert.equal(namedSymbols(dir, "What does `nothing_here` do?", 2000), "");
});

test("symlinks and device files are never read: nothing outside the project reaches the prompt, and nothing hangs", () => {
  const outside = project({ "secret.py": "def leaked_secret():\n    pass\n" });
  const dir = project({ "a.py": "def other():\n    pass\n" });
  symlinkSync(join(outside, "secret.py"), join(dir, "linked.py"));
  symlinkSync("/dev/zero", join(dir, "zero.py"));
  const started = Date.now();
  assert.equal(namedSymbols(dir, "What does `leaked_secret` do?", 2000), "");
  assert.ok(Date.now() - started < 5000, "did not hang on /dev/zero");
});
