import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { projectMap } from "./projectmap.ts";

function project(files: string[], gitignore?: string) {
  const dir = mkdtempSync(join(tmpdir(), "cadre-map-"));
  for (const file of files) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), "");
  }
  if (gitignore !== undefined) {
    writeFileSync(join(dir, ".gitignore"), gitignore);
    execFileSync("git", ["init", "-q"], { cwd: dir });
  }
  return dir;
}

test("descry's index cache is not listed as project files", () => {
  for (const gitignore of [undefined, ""]) {
    const dir = project(["inventory/store.py", ".descry_cache/codebase_graph.json"], gitignore);
    const map = projectMap(dir, "", 2000);
    assert.ok(map.includes("inventory/store.py"));
    assert.doesNotMatch(map, /descry_cache/);
  }
});

test("a small project lists every file, without what git ignores", () => {
  const dir = project(["inventory/store.py", "inventory/__init__.py", "tests/test_store.py", "build/out.bin"], "build/\n");
  const map = projectMap(dir, "", 2000);
  assert.match(map, /^Project files \(paths relative to the working directory\):\n/);
  for (const file of ["inventory/store.py", "inventory/__init__.py", "tests/test_store.py", ".gitignore"]) assert.ok(map.includes(file), file);
  assert.doesNotMatch(map, /out\.bin/);
});

test("outside git, dependency and build directories are skipped", () => {
  const dir = project(["src/main.rs", "node_modules/pkg/index.js", "target/debug/app"]);
  const map = projectMap(dir, "", 2000);
  assert.match(map, /src\/main\.rs/);
  assert.doesNotMatch(map, /node_modules|target\/debug/);
});

test("a large project shows top-level directories with file counts, plus files the prompt names", () => {
  const files = Array.from({ length: 400 }, (_, i) => `pkg${i % 4}/module_${i}.py`).concat(["README.md"]);
  const dir = project(files, "");
  const map = projectMap(dir, "What does pkg2/module_202.py do?", 600);
  assert.ok(map.length <= 600, `${map.length} characters`);
  assert.match(map, /pkg0\/ \(100 files\)/);
  assert.match(map, /README\.md/);
  assert.match(map, /pkg2\/module_202\.py/);
});

test("a repository's own git config cannot run a command while the map is built", () => {
  const dir = project(["a.txt"], "");
  const marker = join(dir, "ran");
  execFileSync("git", ["config", "core.fsmonitor", `touch ${marker}`], { cwd: dir });
  projectMap(dir, "", 2000);
  assert.equal(existsSync(marker), false, "core.fsmonitor ran");
});
