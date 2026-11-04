/**
 * Path guard for tool calls. Writes and edits must stay inside the project (the working directory). Reads, searches,
 * and bash commands may also use system directories (/usr, /etc, /opt, ...), but nothing else outside the project:
 * not the home directory, not the project's parent, not temporary directories. Bash commands are checked by the paths
 * written in them, so the guard catches mistakes rather than enforcing a sandbox.
 */

import { lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WRITE_TOOLS = new Set(["write", "edit"]);
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const SHELL_WORD_BREAKS = /[\s;|&()<>'"`=]+/;
const SYSTEM_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt", "/dev", "/proc", "/sys", "/nix", "/System", "/Library"];
const MAX_LINKS = 40;
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * `path` as Pi's file tools will open it (Pi 1.4's normalizePath, used by read, write, edit, grep, find and ls):
 * Unicode spaces made plain, a leading "@" dropped, MSYS-style drive paths converted on Windows, "~" expanded, and a
 * file:// URL turned into its path. The guard must check this, not the path as written: "~/.bashrc" passed as a project
 * file while Pi wrote the home directory's.
 */
function asPiOpens(path: string, home: string): string {
  let p = path.replace(UNICODE_SPACES, " ");
  if (p.startsWith("@")) p = p.slice(1);
  if (process.platform === "win32") {
    const drive = !p.startsWith("//") && !p.includes("\\") ? p.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i) : null;
    if (drive) p = `${drive[1].toUpperCase()}:\\${drive[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  if (p === "~") return home;
  if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"))) return join(home, p.slice(2));
  if (/^file:\/\//.test(p)) {
    try {
      return fileURLToPath(p);
    } catch {
      return "/";
    }
  }
  return p;
}

/**
 * Resolves `path` against `cwd` the way the operating system does: one component at a time, following each symlink
 * (even one whose target is missing) before applying any later "..", and taking each existing component's on-disk
 * case. A symlink loop, or more than MAX_LINKS links, resolves to the filesystem root, which the guard always blocks.
 */
function physicalPath(path: string, cwd: string, links = { count: 0 }): string {
  const absolute = isAbsolute(path) ? path : `${cwd}${sep}${path}`;
  const { root } = parse(absolute);
  let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]+/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    let isLink = false;
    let exists = true;
    try {
      isLink = lstatSync(next).isSymbolicLink();
    } catch {
      exists = false;
    }
    if (!isLink) {
      // realpathSync.native returns the on-disk case, so case-insensitive file systems compare correctly.
      // A missing component is not a link; the rest of the path stays lexical.
      current = exists ? realpathSync.native(next) : next;
      continue;
    }
    if (++links.count > MAX_LINKS) return root;
    current = physicalPath(readlinkSync(next), current, links);
  }
  return current;
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Returns a shell word that looks like a path with ~, $HOME, and ${HOME} expanded, or undefined for other words. */
function shellPath(word: string, home: string): string | undefined {
  const expanded = word.replace(/^(~|\$\{HOME\}|\$HOME)(?=\/|$)/, home);
  const looksLikePath = expanded !== word || expanded.startsWith("/") || expanded.startsWith(".") || expanded.includes("/");
  return looksLikePath ? expanded : undefined;
}

/**
 * Returns why a tool call reaches outside the project at `cwd`, or undefined when it does not. `home` expands ~ and
 * $HOME, and is never treated as a system directory even when it lies under one. Paths are compared after following
 * symlinks.
 */
export function guardReason(toolName: string, input: Record<string, unknown>, cwd: string, home: string): string | undefined {
  const realCwd = physicalPath(cwd, "/");
  const realHome = physicalPath(home, "/");
  const systemDirs = SYSTEM_DIRS.map((dir) => physicalPath(dir, "/"));
  const readable = (path: string) =>
    isInside(path, realCwd) || (!isInside(path, realHome) && systemDirs.some((dir) => isInside(path, dir)));
  let paths: string[] = [];
  if (toolName === "bash" && typeof input.command === "string") {
    paths = input.command.split(SHELL_WORD_BREAKS).flatMap((word) => shellPath(word, home) ?? []);
  } else if ((WRITE_TOOLS.has(toolName) || READ_TOOLS.has(toolName)) && typeof input.path === "string") {
    paths = [asPiOpens(input.path, home)];
  }
  const outside = paths
    .map((path) => physicalPath(path, realCwd))
    .find((path) => (WRITE_TOOLS.has(toolName) ? !isInside(path, realCwd) : !readable(path)));
  if (outside === undefined) return undefined;
  const reason =
    `${toolName} reaches ${outside}, outside the project ${cwd}. Paths inside the project work: relative paths start at ${cwd}. ` +
    "For information from the web, use web_search. To work outside the project, ask the user to run /cadre-guard off.";
  // A blocked search for a name gets the project's files with that name, found here without running the command.
  const found = toolName === "bash" && typeof input.command === "string" ? projectMatches(cwd, namePatterns(input.command)) : [];
  return found.length ? `${reason} Project files matching: ${found.join(", ")}` : reason;
}

// Directories a project search skips, and its limits.
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "target", "dist", "build", "__pycache__", ".next"]);
const MAX_ENTRIES = 5000;
const MAX_MATCHES = 10;

const glob = (pattern: string, flags: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, flags);

/**
 * What a shell command searches for by name: find's -name, -iname, and -path patterns, and the file name of an
 * absolute path argument (one with an extension).
 */
function namePatterns(command: string): { path: boolean; re: RegExp }[] {
  const unquote = (word: string) => word.replace(/^['"]|['"]$/g, "");
  const patterns: { path: boolean; re: RegExp }[] = [];
  for (const m of command.matchAll(/-(i?name|i?path)\s+('[^']*'|"[^"]*"|\S+)/g)) {
    patterns.push({ path: m[1].endsWith("path"), re: glob(unquote(m[2]), m[1].startsWith("i") ? "i" : "") });
  }
  if (!patterns.length) {
    const name = command.match(/(?:^|\s)['"]?\/[^\s'"]*\/([^\s'"/]+\.[A-Za-z0-9]+)['"]?(?=\s|$)/)?.[1];
    if (name) patterns.push({ path: false, re: glob(name, "") });
  }
  return patterns;
}

/** Project files (relative paths) matching every pattern, breadth first within the entry and match limits. */
function projectMatches(cwd: string, patterns: { path: boolean; re: RegExp }[]): string[] {
  if (!patterns.length) return [];
  const found: string[] = [];
  const queue = [""];
  let seen = 0;
  while (queue.length && seen < MAX_ENTRIES && found.length < MAX_MATCHES) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(join(cwd, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen > MAX_ENTRIES || found.length >= MAX_MATCHES) break;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(rel);
      } else if (patterns.every((p) => p.re.test(p.path ? `./${rel}` : entry.name))) {
        found.push(rel);
      }
    }
  }
  return found;
}
