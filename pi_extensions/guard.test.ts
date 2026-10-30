import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { guardReason } from "./guard.ts";

const HOME = "/home/u";
const CWD = "/home/u/proj";
const guard = (toolName: string, input: Record<string, unknown>) => guardReason(toolName, input, CWD, HOME);

test("blocks the commands agents ran outside their project", () => {
  for (const command of [
    "cd /home/u/Documents/lfm-test && ls",
    'grep -rln "commit_ships" /home/u --include=*.py',
    "find / -name test_store.py 2>/dev/null",
    "ls ~/.ssh",
    "cat $HOME/.npmrc",
    "cat ${HOME}/.npmrc",
    "ls ../other",
    "cd /home/u && mkdir -p inventory/tests && mv proj/tests/test_store.py inventory/tests/",
    "pip install --target=/tmp/inv_test inventory",
  ]) {
    assert.ok(guard("bash", { command }), command);
  }
});

test("blocks the parent of a project outside the home directory", () => {
  const reason = guardReason("bash", { command: "cd /srv/work && ls" }, "/srv/work/proj", HOME);
  assert.ok(reason);
});

test("allows project paths, system directories, and plain commands", () => {
  for (const command of [
    "python3 -m pytest -q",
    "cd /home/u/proj/tests && ls",
    "ls sub/dir ./x",
    "cat /etc/hosts /usr/lib/os-release",
    "/opt/homebrew/bin/python3 -V 2>/dev/null",
    "curl -s http://127.0.0.1:8080/health",
    "git diff -- a/b",
  ]) {
    assert.equal(guard("bash", { command }), undefined, command);
  }
});

test("writes and edits stay inside the project", () => {
  assert.equal(guard("write", { path: "src/a.py" }), undefined);
  assert.equal(guard("edit", { path: "/home/u/proj/a.py" }), undefined);
  assert.ok(guard("write", { path: "/tmp/a.py" }));
  assert.ok(guard("write", { path: "/usr/local/bin/x" }));
  assert.ok(guard("edit", { path: "../other/a.py" }));
});

test("reads may use system directories but nothing else outside the project", () => {
  assert.equal(guard("read", { path: "/etc/hosts" }), undefined);
  assert.equal(guard("ls", {}), undefined);
  assert.equal(guard("grep", { pattern: "x", path: "tests" }), undefined);
  assert.ok(guard("read", { path: "/home/u/.ssh/id_ed25519" }));
  assert.ok(guard("read", { path: "/tmp/notes.txt" }));
  assert.ok(guard("find", { pattern: "*.py", path: "/" }));
});

function tempTree() {
  const base = mkdtempSync(join(tmpdir(), "cadre-Base-"));
  const cwd = join(base, "Proj");
  mkdirSync(join(cwd, "sub"), { recursive: true });
  mkdirSync(join(base, "Other", "deep"), { recursive: true });
  return { base, cwd };
}

test("follows symlinks before deciding", () => {
  const { base, cwd } = tempTree();
  symlinkSync(join(base, "Other"), join(cwd, "linked"));
  assert.ok(guardReason("write", { path: "linked/new.py" }, cwd, base));
  assert.ok(guardReason("read", { path: "linked" }, cwd, base));
  assert.ok(guardReason("bash", { command: "cat linked/notes.txt" }, cwd, base));
  assert.equal(guardReason("write", { path: "new/dir/file.py" }, cwd, base), undefined);
});

test("resolves dangling links, '..' after a link, and loops the way the OS does", () => {
  const { base, cwd } = tempTree();
  symlinkSync(join(base, "missing", "target.py"), join(cwd, "dangling.py"));
  symlinkSync(join(base, "Other", "deep"), join(cwd, "linked"));
  symlinkSync("loop", join(cwd, "loop"));
  assert.ok(guardReason("write", { path: "dangling.py" }, cwd, base));
  assert.ok(guardReason("write", { path: "linked/../escaped.py" }, cwd, base));
  assert.ok(guardReason("bash", { command: "cat linked/../../secret" }, cwd, base));
  assert.ok(guardReason("write", { path: "loop/x" }, cwd, base));
  assert.equal(guardReason("write", { path: "sub/../ok.py" }, cwd, base), undefined);
});

test("compares paths in on-disk case on case-insensitive file systems", (t) => {
  const { base, cwd } = tempTree();
  if (!existsSync(cwd.toLowerCase())) {
    t.skip("file system is case-sensitive");
    return;
  }
  assert.ok(guardReason("read", { path: join(base, "Other").toLowerCase() }, cwd, base));
  assert.ok(guardReason("bash", { command: `ls ${join(base, "other").toUpperCase()}` }, cwd, base));
  assert.equal(guardReason("write", { path: join(base, "proj", "x.py") }, cwd, base), undefined);
});
