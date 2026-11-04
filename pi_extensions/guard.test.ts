import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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

test("a blocked search with many wildcards finds matching project files quickly", () => {
  // The suggestion turned each pattern into a regex; ten '*'s against a 200-character file name backtracked for 132 s.
  const dir = mkdtempSync(join(tmpdir(), "cadre-glob-"));
  writeFileSync(join(dir, "a".repeat(200)), "");
  writeFileSync(join(dir, "store.py"), "");
  const started = Date.now();
  guardReason("bash", { command: "find / -name '" + "*a".repeat(10) + "*b'" }, dir, "/home/nobody");
  assert.ok(Date.now() - started < 500, `${Date.now() - started} ms`);
  assert.match(guardReason("bash", { command: "find / -name 's?ore.*'" }, dir, "/home/nobody") ?? "", /Project files matching: store\.py/);
  assert.match(guardReason("bash", { command: "find / -iname 'STORE.PY'" }, dir, "/home/nobody") ?? "", /Project files matching: store\.py/);
  assert.doesNotMatch(guardReason("bash", { command: "find / -name 'store.p'" }, dir, "/home/nobody") ?? "", /Project files matching/);
});

test("a path Pi's tools rewrite (~, @, file://) is checked as Pi will use it", () => {
  // Pi's read, write and edit tools expand ~, strip a leading @ and convert file:// URLs before opening the file; the
  // guard checked the path as written and let "~/.bashrc" through as a project file.
  const outside = [`~/.bashrc`, `~`, `@${HOME}/.zshrc`, `@~/.ssh/id_rsa`, `file://${HOME}/.zshrc`, `\u00a0~/.bashrc`.trim(), `~/.ssh/id_rsa`];
  for (const path of outside) {
    assert.ok(guardReason("write", { path }, CWD, HOME), `write ${path}`);
    assert.ok(guardReason("read", { path }, CWD, HOME), `read ${path}`);
  }
  for (const path of [`@src/app.py`, `file://${CWD}/src/app.py`, `@${CWD}/notes.md`]) assert.equal(guardReason("write", { path }, CWD, HOME), undefined, path);
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
  assert.ok(guardReason("bash", { command: "cat linked/../../secret" }, cwd, base));
  assert.ok(guardReason("write", { path: "loop/x" }, cwd, base));
  assert.equal(guardReason("write", { path: "sub/../ok.py" }, cwd, base), undefined);
});

test("a file tool's '..' applies before symlinks, as Pi resolves the path before opening it", () => {
  // Pi's file tools resolve the path lexically against the working directory, then open the result: a link followed
  // by '..' does not lead where the link points. The OS order (link first) let "current/../../.bashrc" through while Pi
  // wrote the home directory's .bashrc.
  const { base, cwd } = tempTree();
  mkdirSync(join(cwd, "releases", "v1", "build"), { recursive: true });
  symlinkSync(join(cwd, "releases", "v1", "build"), join(cwd, "current"));
  symlinkSync(join(base, "Other", "deep"), join(cwd, "linked"));
  assert.ok(guardReason("write", { path: "current/../../.bashrc" }, cwd, base));
  assert.ok(guardReason("read", { path: "current/../../.bashrc" }, cwd, base));
  assert.equal(guardReason("write", { path: "linked/../inside.py" }, cwd, base), undefined);
});

test("a read is checked under the other spelling Pi opens when the path is missing", () => {
  // Pi's read falls back to the path with ' as \u2019, " AM."/" PM." with a narrow no-break space, and NFD: a link
  // named x\u2019y in the project made read "x'y/..." open the link's target outside the project.
  const { base, cwd } = tempTree();
  writeFileSync(join(base, "Other", "secret"), "");
  symlinkSync(join(base, "Other"), join(cwd, "x\u2019y"));
  symlinkSync(join(base, "Other"), join(cwd, "Shot 1.02\u202fPM.dir"));
  symlinkSync(join(base, "Other"), join(cwd, "cafe\u0301"));
  assert.ok(guardReason("read", { path: "x'y/secret" }, cwd, base));
  assert.ok(guardReason("read", { path: "Shot 1.02 PM.dir/secret" }, cwd, base));
  assert.ok(guardReason("read", { path: "caf\u00e9/secret" }, cwd, base));
  assert.equal(guardReason("read", { path: "sub/it's 1 PM.txt" }, cwd, base), undefined);
});

test("a project under a directory with ' or ' AM.' in its name can still be read", () => {
  // Pi tries the other spellings only when the path is missing, and opens the first that exists; checking spellings
  // that do not exist blocked every read in such a project.
  for (const name of ["o'brien", "shot 9 AM.", "jos\u00e9"]) {
    const base = mkdtempSync(join(tmpdir(), "cadre-Base-"));
    const cwd = join(base, name, "proj");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "a.txt"), "");
    assert.equal(guardReason("read", { path: "a.txt" }, cwd, base), undefined, name);
    assert.equal(guardReason("read", { path: "missing.txt" }, cwd, base), undefined, name);
  }
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

test("a block says the way forward: project paths, and web_search for information from the web", () => {
  const reason = guardReason("bash", { command: "find / -name store.py" }, "/work/inv", "/Users/me")!;
  assert.match(reason, /Paths inside the project work: relative paths start at \/work\/inv\./);
  assert.match(reason, /For information from the web, use web_search\./);
  // LFM3 presented the block text as the file's contents ("Here's what's in each file") in 8 of 10 exact replays;
  // starting with "Blocked:" it did so in 0 of 10, and Spark answered correctly 10 of 10 either way.
  assert.match(reason, /^Blocked: bash reaches /);
});

test("a blocked search for a name lists the project files with that name, without running the command", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cadre-find-"));
  mkdirSync(join(cwd, "inventory"));
  mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(cwd, "inventory", "store.py"), "");
  writeFileSync(join(cwd, "node_modules", "pkg", "store.py"), "");
  for (const command of ['find / -name "store.py" 2>/dev/null', "find / -path '*inventory*' -name '*.py'", "ls /Users/me/Documents/lfm-test/inventory/store.py"]) {
    const reason = guardReason("bash", { command }, cwd, "/Users/me")!;
    assert.match(reason, /Project files matching: inventory\/store\.py\b/, command);
    assert.doesNotMatch(reason, /node_modules/, command);
  }
  assert.doesNotMatch(guardReason("bash", { command: "cat /etc/../Users/me/secret.txt" }, cwd, "/Users/me")!, /Project files matching/);
});
