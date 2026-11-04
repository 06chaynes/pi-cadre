# Changelog

All notable changes to pi-cadre will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to pre-1.0 semver (minor-version bumps may include breaking changes).

## [Unreleased]

## [0.3.2]

### Security

- The path guard checks a file tool's path as Pi opens it: `~`, a leading `@`, `file://` URLs, Unicode spaces and (on
  Windows) MSYS drive paths are expanded first (`~/.bashrc` passed as a project file), `..` applies before symlinks
  (Pi resolves the path as text, so a project link followed by `..` reached outside), and a read is checked under the
  spelling Pi's read opens when the path as written is missing (`'` as U+2019, ` AM.`/` PM.`, NFD).
- Passages a source-check note quotes from web pages, and errors of failed calls, reach the model as a tool result
  (`cadre_sources`) before the note instead of inside it; the note goes to the model as a user turn. Exact replays of
  the step after a note: the model acted on it in 57 of 60 samples against 52, and went after the flagged item as
  often as before.
- The in-code digest carries only earlier compaction or branch summaries, not cadre's own notes (which quoted web
  text), and text carried into it cannot close the `<summary>` tag Pi wraps it in.
- A file name with control characters (a newline among them) never reaches the project map, in or outside git.
- Linear time on text from web pages and projects: search terms (a long run of capitals took 2.4 s at 40,000
  characters), a blocked search's file-name suggestions (a wildcard pattern took 132 s), trailing punctuation after a
  URL (80,000 dots took 10 s), the path pattern of the source check (a 200,000-letter word took 63 s), relative link
  targets on fetched pages (24 s), the closing punctuation of a listed item (18 s), and the file-name pattern that
  classifies a prompt (200,000 characters of hyphen- or dot-joined words in a pasted prompt took up to 250 s).

### Changed

- The README recommends descry and gives its install line (`uv tool install 'descry-codegraph[all]'`).

### Fixed

- Windows launchers, checked case by case against the shell scripts on a Windows Server 2022 VM:
  `start_llama_server.bat -m dual` (or dual mode with any flag) started nothing, because `shift` also moves `%0` and
  the script relaunched a file named after the last flag; it now keeps its own path. It also gains what the shell
  script and README already offered: `-h`/`--help`, the long flags, and arguments after `--` (`-- --device <name>`).
  Errors go to stderr. `searxng.bat` prints its header as help (it printed internal comments and `^|`) and generates
  the SearXNG secret with a cryptographic generator instead of `Get-Random`.
- Shell launchers: dual mode passes `-ngl` to both servers (each reread the config and dropped it) and exits 0 when
  both servers exit cleanly; a `.GGUF` path in capitals counts as a local file, as on Windows; `searxng.sh --help` no
  longer prints `set -euo pipefail`.
- descry runs on Windows: pip and uv install its server as `descry-mcp.exe`, which cadre did not look for, so Windows
  sessions ran without it. Checked on the Windows Server 2022 VM: cadre's MCP calls against `descry-mcp.exe` index,
  load embeddings and return symbols.
- Arguments after `--` reach llama-server unchanged on Windows, in both modes: values with `=`, `,` or `;` were split,
  and in dual mode a quoted `&` or `)` broke the command.
- A file deep in the tree (a relative path over 200 characters, with / or \\) stays in the project map and descry's
  symbols.
- The research check stays quiet when the guard blocked a call on a path the prompt names ("Show me what is in
  ../../.zshrc"): after the guard blocked the reads and the model said so, the check asked for web sources and Spark
  searched about sandboxes for seven minutes. Decided from the session, not from the prompt's wording.
- A quotation of a fetched page matches it when the page writes the quoted words as Markdown links ("[Ruth
  Chepng'etich](url)"): the source check named correct Wikipedia quotes, and the model spent minutes re-verifying them.
  Over 227 saved answers this removes two quote flags (both such cases) and adds none.
- A path-guard block starts with "Blocked:". LFM3 presented the block text as the file's contents ("Here's what's in
  each file") in 8 of 10 exact replays of a blocked read; with the prefix, in none (Spark answered correctly 10 of 10
  either way).
- A tool result cadre inserts (recall after compaction, a source check's passages) has an ID made from its content,
  so the server's prompt cache is reused.
- `tests/test_launchers.py` runs the launchers of the platform it is on (CI covers Linux, macOS and Windows) with
  stand-ins for llama-server and pi, against the same expected calls.

## [0.3.1]

### Changed

- The request prefix stays the same between clearing events, so llama-server reuses its cached prompt. Logged requests
  of a large write-up showed three rebuild sources: stripping the previous step's reasoning on every request (the server
  rebuilt that step and its result each time), clearing just enough to fit (5-8 clearing events, each rebuilding from
  the first cleared result on), and recall passages chosen with the current step's words (they changed between requests
  and rebuilt ~30k tokens with no clearing). Now clearing frees down to 60% of its room, earlier steps' reasoning leaves
  only when clearing runs (or past 12,000 characters), and recall queries come from the task alone. Large-repository
  write-up at 64k, 2 runs each: both runs finished (21 and ~25 min) against none; prompt tokens processed ~160k against
  ~660k; rubric coverage 8 and 10 of 10 in each arm. Validation at the default 32k: research 12 and 13 of 14, coding
  6/6 twice, exploration 10/10 twice, open research question answered twice.

### Fixed

- The source check judged circular support by the model's original query, but the query cleaner had already removed
  the guessed number before the search ran: "2007" for the iPhone was flagged though the search never contained it.
  Guesses are now read from the arguments as the call ran; a fetched URL that carries a guess still counts.
- A number inside a fetched URL (`iphone-purchased-1978`) supported the same number as a claim; fetched URLs now support
  only cited URLs.
- A short answer line that refers to a listed item by number ("- Item 9: 299,792,458 m/s.") was flagged for lacking
  topic words; it is now checked with that item's text. Wrong values on such lines stay flagged.
- Moving to another branch of a session kept the reasoning mark set on the first branch, so a branch with older steps
  lost all their reasoning, the step being continued from included; the mark now restarts on a branch move.
- With descry 1.1, which answers keyword-only while its embedding model loads, cadre's first search ran during that
  load: the expected function was in the symbol list for 5 of 12 navigation questions instead of 12. cadre now waits for
  descry's health report to say the model is loaded (within its 15 s search budget).

## [0.3.0]

### Added

- Long tasks keep their context in code, never by asking the model:
  - Tool results the model has read stay in full while they fit; older ones are cleared to their opening and the lines
    matching their call and the request (previously a cleared result was dropped whole).
  - When the conversation still fits, threshold compaction is cancelled; when it does not, earlier steps of the current
    request are condensed in code (the request verbatim, each call and its outcome) instead of by a model summary.
  - Passages of cleared web results that match the task come back inside the result they came from (BM25, one query
    per listed item), from the full original kept on disk per session (`~/.local/state/pi-cadre/results`, 7 days).
  - Earlier steps' reasoning leaves each request (Spark's template renders all of it).
- End-of-run source check: one corrective step when the answer, or a prose file written in the run, holds a number,
  quote or URL that no source passage about the same item supports, a value found only through a search that already
  contained it, or a URL that only failed to load. Offline it raised no false alarms in 45 coding sessions; in replays
  Spark searched again or re-read sources after the note in 28 of 30 samples; live it fired twice in 18 questions, both
  justified, both fixed.
- Research check: a question about the world answered without any source gets one step asking for a search with the
  installed tools. In replays Spark searched after the note in 60 of 60 samples.
- Search queries lose numbers that no request or earlier result contains (the model's guesses): a guessed "1978" in
  the iPhone query led to the wrong year in 8 of 10 replays, 0 of 10 without it.
- Project file map in the system message: Spark read a named file directly 10/10 with it, 2/10 without.
- Today's date in the system message: searches for "latest" named the current year 10/10 with it, 0/10 without.
- Syntax check after edit and write (Python, JavaScript, TypeScript, Rust, Go, when the parser is installed) reports a
  broken file in the same tool result.
- Path-guard blocks say the way forward and list matching project files.
- Web results from any tool are shortened by their hits (each hit's title and URL, best passages first).
- Optional reranker (`MODEL=reranker`, Qwen3-Reranker-0.6B on port 8082): while it runs, a cleared result keeps the
  passages it scores highest for the request item the call served. The answer stayed in 238 of 254 answer-bearing
  results at the clearing budget, against 153 with line matching; in replays of the iPhone write step the wrong year
  fell from 8 to 3 of 10 (thinking off) and 5 to 2 (low); live research scores were level (40 and 41 of 42). Without it, line
  matching is used.
- Optional descry integration: when `descry-mcp` is installed, each session starts it and the system message lists the
  symbols matching the prompt (name and file:line), found in code, with no tools added for the model. On a large Rust
  repository (12 navigation questions, 3 rounds): 36/36 with descry (either embedding model) against 33/36 without,
  with 121-143 tool calls against 260.
- `launchers/searxng.sh` / `.bat`: set up, check and tear down a local SearXNG for web search without an API key.

### Changed

- Thinking is low by default for every prompt, with a per-request budget (1,024 tokens low, 4,096 high, at most half
  the reply limit). Off vs low vs high: research 38/42, 40/42, 27/42 (high failed to finish one run); write-up 2/3,
  3/3, 3/3 finished; coding 12/12 at every level.
- An edit that starts on LFM3 continues on Spark (local-code tasks 30/30 vs 28/30 on LFM3 alone).
- The reply limit is set from the measured request size (stale limits of 1 or 17 tokens previously cut replies).
- The web search result-count cap is removed; results are shortened by their hits instead.
- Kept tool results use half of what Spark's window leaves, without a fixed 16,384-token cap. The cap never bound at
  the default 32k slot but held a 64k slot at 16k of ~28k: roles write-ups on a large Rust repository at 64k wrote the
  document in 2 of 4 runs with it and 3 of 4 without (rubric coverage 3 and 5 vs 6, 4 and 7 of 10). At 32k neither
  finished; the README says large-repo write-ups need a larger Spark slot.
- Cleared local reads and command output are recalled while current (a read until its file changes, other output until
  any file does), and a task without a list gets one recall query per clause. In replays this restored the passages of
  re-read files but did not by itself stop the re-reading; the window size did.

### Fixed

- Clearing never applied (context edits were sent in the wrong shape).
- Six parallel searches overflowed the context (39,699 tokens): parallel calls now share the room for new results.
- Thinking could use a whole reply and leave no answer; a reply cut off at the limit now continues.
- Product names in camel case (iPhone, eBay, macOS) routed research questions to LFM3 as local code.
- Source-check false alarms found in validation runs, each fixed with a test and checked offline over all saved sessions
  (flags removed, none added): an HTTP status reported from a failed call, read with that call's URL; quoted labels of
  three words or fewer; a run-together power copied from a source (2136,279,841); line numbers into files, now checked
  against the numbered lines of the reads (a wrong one is still named); a quoted doc comment spanning lines; a URL that
  a web call fetched, or that a fetched page links to relatively.
- Numbers the model guessed in a query no longer decide which lines of a result are kept (the iPhone case kept four
  1978 passages and dropped the 2007 one).
- Security: recall never arrives as a user turn; syntax checkers run isolated (`python -I`, neutral directory); git and
  llama-server never run from the project directory, so a planted `git` there cannot run on Windows; the project map
  runs git with fsmonitor off; reads follow regular files only.

## [0.2.2]

### Fixed

- A single tool result could exceed every context window: a web search returned about 40,000 tokens, more than Spark's 32k slot, so moving the turn to Spark (0.2.1) still failed. Any tool result longer than 40% of the largest context window is now shortened to its start plus the lines that contain words from the request, with a note on what was left out. With a 150,000-character search result, the answer line was kept and the question was answered correctly in 2 of 2 runs.

## [0.2.1]

### Added

- Truncated read and bash results get the lines outside the shown part that contain words from the request, with line numbers. Asked for a fact on line 901 of a 116 KB file, Spark read the first 50 KB, sampled the end, and answered that the fact was absent in 2 of 2 runs; with the matches appended it answered correctly in 3 of 3, in 3 to 5 seconds.

### Fixed

- `cadre` kept a turn on LFM3 after a large tool result, and the next request exceeded LFM3's context (a 30k-token web search against a 16k slot). The router now estimates each request's size and sends it to Spark when it would not fit LFM3 with room for the reply. llama.cpp's context error did not trigger Pi's retry, so the retry path could not catch it.

## [0.2.0]

### Added

- `llama-cpp/cadre` model: routes each prompt to LFM3 (questions and single-spot edits) or Spark (everything else). A turn stays on its model, a failed LFM3 request retries on Spark, and compaction runs on Spark. In Pi sessions LFM3 matched Spark on reading, small edits, and a contained bug fix, and failed a multi-step feature.
- At startup with a UI, the extension offers to start servers that are not running and to switch to `cadre`. `/cadre-start` starts them on demand.

### Changed

- The path guard allows reads only inside the project and in system directories. It previously allowed anything outside the home directory, which let an agent work in the project's parent under `/tmp` and move a test file out of the project.
- LFM3 defaults to 4 slots x 16k instead of 16 x 2k; Pi's system prompt and tools do not fit in 2k. The dual profile starts Pi on `cadre`.
- The extension is split into `cadre.ts`, `servers.ts`, `router.ts`, and `guard.ts`.

## [0.1.1]

### Added

- Path guard, on by default. Blocks writes and edits outside the working directory, and reads, searches, and bash commands that reach the filesystem root or the home directory outside the working directory. Paths are compared after following symlinks. `/cadre-guard off` turns it off for the session. In testing, Spark's first command in a sandbox was `cd` into an unrelated repo under the home directory; the guard blocked it and Spark returned to the project.

## [0.1.0]

### Added

- Pi package (`pi install npm:pi-cadre`). Tagged releases are staged on npm through trusted publishing and published after 2FA approval.
- The extension registers the `llama-cpp` provider with Spark-X2.6-4B (port 8080) and LFM3-1.7B (port 8081), sized from each server's per-slot context.
- Thinking levels are sent as chat template kwargs each model accepts. Pi's `medium` maps to Spark's `high`.
- `/cadre-status` reports both servers. Auto thinking also covers debugging, investigation, and review prompts.

### Changed

- Renamed from pi-lfm3: `cadre_config.env`, `launchers/pi_cadre.*`, `/cadre-*` commands.
- The default dual profile gives Spark 4 slots x 32k instead of 8 x 8k, which agent sessions outgrew.
- The setup wizard registers the repo as a Pi package, removes the `llama-cpp` provider earlier versions wrote to `models.json`, and keeps other Ollama models when adding `lfm3:latest`.

### Fixed

- Prompts that triggered auto thinking failed with HTTP 400 on Spark, and thinking "off" left Spark thinking at high effort.
- Benchmark battery: environment control checks, snippet dedenting, syntax repair by token backtracking, schema-aware JSON prompts, and scout routing to LFM3.
