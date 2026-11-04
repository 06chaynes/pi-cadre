# pi-cadre

Runs the [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) against local GGUF models served by `llama.cpp`:

- **Spark-X2.6-4B** (`XHToken/Spark-X2.6-4B-GGUF:Q4_K_M`) on port 8080
- **LFM3-1.7B** (`LiquidAI/LFM3-1.7B-GGUF:Q4_K_M`) on port 8081

Ollama (`lfm3:latest`) is supported as an alternative backend for LFM3.

The repository also contains a Python client that routes requests between the two models, and a benchmark battery that uses it.

> ### Disclaimer: please read
>
> **This project was built with heavy assistance from AI coding agents.** It has been reviewed, but AI-written code
> can still contain subtle defects, missed edge cases, or security assumptions that weren't obvious to the reviewer.
> Treat it as experimental software.
>
> **It is designed to run locally on your own machine.** The launchers bind `llama-server` to `127.0.0.1` with no
> authentication, and the Pi provider uses the placeholder API key `none`.
>
> - Do not set `HOST` to a network address or expose the servers through a proxy or tunnel. Anything that can reach
>   the port can use the models.
> - The setup wizard edits `~/.pi/agent/models.json` and `settings.json`, and can install packages with npm, Homebrew,
>   or Ollama. Run it with `--dry-run` first to see what it will change.
> - The benchmark battery modifies files in, and runs tests from, the `requests_repo/` clone. Point it only at a
>   checkout you are willing to have reset with `git checkout -f`.

## Install

```bash
./install.sh                # macOS / Linux, same as: python3 setup_wizard.py
install.bat                 # Windows, same as: python setup_wizard.py
```

The wizard:

1. Asks for a backend: llama.cpp (default) or Ollama.
2. Installs Pi with npm if it is missing.
3. Asks for a server profile and writes it to `cadre_config.env`.
4. Adds this repo as a Pi package in `~/.pi/agent/settings.json` and adds `lfm3:latest` to the Ollama provider in `models.json`, keeping its other models. It removes the `llama-cpp` provider that earlier versions wrote to `models.json`, because that entry would override the extension's. `PI_CODING_AGENT_DIR` overrides the directory.

To add only the Pi extension, without the wizard:

```bash
pi install npm:pi-cadre                       # published releases
pi install git:github.com/06chaynes/pi-cadre    # latest main
```

### Recommended: descry

[descry](https://pypi.org/project/descry-codegraph/) indexes the project's code, and cadre lists the symbols that
match each prompt (name and file:line) for the model. On a large Rust repository, "which function, in which file"
questions went from 33 to 36 of 36, with about half the tool calls and a third less time. Install it with its embedding
support; cadre finds it on `PATH` and starts it in each session:

```bash
uv tool install 'descry-codegraph[all]'      # or: pipx install 'descry-codegraph[all]'
```

The extension registers the `llama-cpp` provider at startup. It reads each server's per-slot context from `/props` and uses the launcher default (Spark 32768, LFM3 16384) for a server that is not running yet. Thinking levels are sent as chat template kwargs: Spark accepts `low` and `high` effort, so Pi's `medium` maps to `high`.

It also registers `llama-cpp/cadre`, a model that picks Spark or LFM3 for each prompt. LFM3 gets questions and single-spot edits (a docstring, a typo, a rename); Spark gets everything else, including anything that mentions tests, several steps, or a change to behavior. A turn stays on the model that started it unless the conversation outgrows LFM3 (for example after a large tool result), a failed LFM3 request retries on Spark, and prompts the router cannot classify go to Spark. Routing to LFM3 needs at least 8192 tokens per LFM3 slot.

When Pi starts with a UI, the extension offers to start any server that is not running, and to switch to `cadre` when another provider's model is selected. With only the npm package installed, servers it starts use the launcher defaults, and `SPARK_MODEL` / `LFM3_MODEL` in the environment select local `.gguf` files or other Hugging Face IDs. They keep running after Pi exits, with logs in `~/.local/state/pi-cadre` (or `$XDG_STATE_HOME/pi-cadre`).

Run `python3 setup_wizard.py --help` for the unattended and dry-run flags.

## Run

```bash
./launchers/start_llama_server.sh       # Windows: launchers\start_llama_server.bat
./launchers/pi_cadre.sh                  # Windows: launchers\pi_cadre.bat; ./pi-cadre is a shortcut
```

`MODEL` in `cadre_config.env` controls both launchers:

| `MODEL` | Server | Pi uses |
|---|---|---|
| `dual` | Spark on 8080 (4 slots x 32k) and LFM3 on 8081 (4 slots x 16k) | `cadre`, routed per prompt |
| `spark` | Spark on 8080 | Spark |
| `lfm3` | LFM3 on 8081 | LFM3 |
| `reranker` | Qwen3-Reranker-0.6B on 8082 (optional, run beside the others) | not a chat model |
| HF repo ID or `.gguf` path | that model on `PORT` (default 8080) | Spark entry on 8080 |

Command-line flags override the config; run `start_llama_server.sh --help` to list them. By default `spark` and `lfm3` download the Q4_K_M quants from Hugging Face. To use local files or other quants, set `SPARK_MODEL` and `LFM3_MODEL` to a `.gguf` path or Hugging Face ID.

Long write-ups that read many files of a large repository need more than a 32k slot on Spark: at 32k the model
re-read cleared files until it ran out of time, while with `MODEL=spark` and `PARALLEL_SLOTS=2` (2 slots of 64k) it
wrote the document in 3 of 4 runs. Fewer slots means fewer requests served at once.

On machines with more than one GPU, llama.cpp splits layers across all of them. Add `-- --device <name>` to pin a server to one device; `llama-server --list-devices` lists the names.

With Ollama, start the server with `launchers/start_ollama.sh` (or `.bat`) and run `pi`.

### Local web search (optional)

Pi's web tools come from separate packages. To search without an API key or quota, run a local
[SearXNG](https://github.com/searxng/searxng) and point [`pi-web-access`](https://www.npmjs.com/package/pi-web-access)
at it:

```bash
./launchers/searxng.sh setup      # Windows: launchers\searxng.bat setup; needs Docker
./launchers/searxng.sh status
./launchers/searxng.sh teardown   # add --purge to delete the config too
```

`setup` starts a pinned SearXNG image bound to `127.0.0.1` only and prints the `web-search.json` that keeps every
search on it. SearXNG sends queries to public engines from your IP address; some (Brave, DuckDuckGo) rate-limit
frequent automated queries, so the config enables several others. The extension's handling of web results does not
depend on which search package you use.

### How the extension keeps long tasks working

Small local models have small context windows (Spark gets 32k tokens per slot). The extension manages context in
code, so none of this depends on the model remembering to do it:

- **Real sizes.** Each server's per-slot window is read from llama-server, and each request's reply limit is set from
  the request's actual token count.
- **Tool results fit.** A result larger than its share of the window is shortened. Search results keep each hit's
  title and URL and the passages that best match the search and your request; other results keep their opening and
  the matching lines, with a note on how to see the rest. Parallel calls share the room.
- **Old results leave; useful passages come back.** During a task, results the model has already read are replaced
  by a short extract once they pass a budget. Passages of cleared web results that match the task are restored inside
  the result they came from (one query per listed item, ranked with BM25). The full text of shortened web results is
  kept in `~/.local/state/pi-cadre/results/` for a week so these passages can come from the cut part too. With the
  optional reranker running (`start_llama_server.sh -m reranker`), a cleared result keeps the passages it scores
  highest for the request item the call served; across 254 results that held an answer, the answer stayed in 238 this
  way and in 153 with line matching. Without it, line matching is used.
- **The server's prompt cache stays useful.** Between clearing events each request starts with exactly what the previous
  one sent, so llama-server reuses its cached prompt and processes only the new step: earlier steps' reasoning leaves,
  and recalled passages change, only when clearing runs, and clearing then frees down to 60% of its room so it runs
  rarely. On a large-repository write-up this cut prompt tokens processed from about 660k to about 160k, and both runs
  finished where the previous version ran out of time.
- **Searches carry what is known, not guesses.** A number in a search query that neither your request nor an earlier
  result contains is removed before the search runs, and such numbers never decide which parts of a result are kept.
  With a guessed year in the query, a search for the first iPhone's release year returned pages about a date bug and
  the answer was wrong in 8 of 10 samples; without it, in 0 of 10.
- **Compaction without a model.** When compaction is still needed, earlier questions and the current request's earlier
  steps are condensed by code: the request verbatim, then each step's call and outcome.
- **Project files and the date.** The system message lists the project's files (from git, bounded in size) and
  today's date, which Pi's own prompt does not include.
- **Code symbols (recommended, see Install).** When [descry](https://pypi.org/project/descry-codegraph/) is installed
  (`descry-mcp` on `PATH`, `descry-mcp.exe` on Windows, or `DESCRY_MCP_BIN`), each session starts its MCP server in the
  working directory and the system message lists the symbols matching the prompt (name and file:line). On a large Rust
  repository this took "which function, in which file" questions from 33 to 36 of 36, with about half the tool calls.
  It needs descry's embedding support (`descry-codegraph[all]`); the first search waits for descry's embedding model to
  load. The first index of a large repository takes a while; see descry's documentation for its settings. Only
  absolute `PATH` entries are searched.
- **Broken edits are reported.** After an edit or write, the file is parsed (Python, JavaScript, TypeScript, Rust, or
  Go, when the parser is installed) and a syntax error is reported in the same tool result.
- **Thinking.** Thinking is low for every prompt. On a 12-item research task, off, low and high scored 38, 40 and 27
  of 42 over three runs each (high over-checked and failed to finish one run, off over-explored and failed to finish
  one write-up); on coding all three passed. Every request with thinking on gets a thinking budget well below its
  reply limit, so reasoning cannot use up a reply.
- **Answers are checked against their sources.** When a run ends, numbers, quotes and URLs in the answer, or in a
  prose file written in the run, are matched against what the tools returned, in a passage about the same item. A
  value with no source, or found only through a search that already guessed it, or a URL that only failed to load, gets
  one step that names it and quotes the closest source passage. A question about the world answered without any source
  gets one step asking for a search with the installed tools.
- **Recovery.** A reply cut off before any answer or tool call continues once. Path-guard blocks say what to do
  instead and list matching project files.
- **Routing.** LFM3 answers questions about local code; edits start on LFM3 and finish on Spark; everything else runs
  on Spark.

Pi commands added by the extension:

- `/cadre-status`: health, model file, and per-slot context of both servers, and whether `cadre` can route to LFM3.
- `/cadre-start`: starts the servers that are not running.
- `/cadre-thinking auto|off|minimal|low|medium|high`: `auto` (the default) uses low thinking for every prompt; another level applies to every prompt until changed.
- `/cadre-guard on|off`: path guard, on by default. Writes and edits must stay inside the working directory. Reads, searches, and bash commands may also use system directories (`/usr`, `/etc`, `/opt`, and similar) but nothing else outside the working directory, including its parent, your home directory, and `/tmp`. Bash commands are checked by the paths written in them, so it catches mistakes rather than acting as a sandbox.

## Python client

`llama_cpp_client.py` provides:

- `AutoThinkingPolicy`: turns thinking off for code and JSON-schema output, and on for diagnosis, planning, and retries after a test failure.
- `AutoModelPolicy`: sends short patching and scouting tasks to LFM3 and everything else to Spark. In `auto` mode the client falls back to whichever server is running.
- `LlamaCppClient.generate_code`: Spark gets its chat template through `/completion`. LFM3 gets a ChatML prompt whose assistant turn is pre-filled with a code fence and the function signature. When the code does not parse, the client regenerates from the token at the parse error using that token's top alternatives. This fixes confident mistakes such as the merged `):` token closing a multi-line condition early.
- `LlamaCppClient.chat_json`: appends the schema's field names to the prompt, so the JSON grammar never forces fields the model was not asked for.

## Tests

```bash
pip install pytest
python3 -m pytest
node --test 'pi_extensions/*.test.ts'   # Node 22.6+
```

The tests need no model server. They cover the routing policies, client request construction, AST helpers, the wizard's config writing, the shell launchers (using stub binaries), and the extension's provider registration. CI runs them on Linux, macOS, and Windows (`.github/workflows/test.yml`).

## Benchmarks

```bash
git clone --branch v2.31.0 https://github.com/psf/requests requests_repo
pip install -r requests_repo/requirements-dev.txt -e requests_repo
python3 run_full_battery_eval.py [--model auto|spark|lfm3]
python3 benchmark_parallel_slots.py [--port 8081]
```

Run the battery with the interpreter that has the `requests` dev requirements (for example `.venv/bin/python`). Before calling a model it checks that each task's test passes on the clean repo and fails with the defect injected, and exits if not.

The battery runs two suites:

- **B:** four defects injected into `requests`, each checked by its tests. See `repo_benchmark.py`.
- **C:** five SWE-bench Lite snippets, scored by whether the expected fix text appears and the output parses.

Results go to `results/`.

Each task description in B and C states the fix. C passes when that exact text appears in the output. These suites therefore measure whether the model applies a described fix, not whether it can find one.

## Layout

| Path | Purpose |
|---|---|
| `setup_wizard.py`, `install.sh`, `install.bat` | Installer |
| `cadre_config.env` | Server settings read by the launchers |
| `launchers/` | Server and Pi launchers |
| `pi_extensions/` | Pi extension: `cadre.ts` (entry), `servers.ts`, `router.ts`, `guard.ts`, and the context modules (`tokens.ts`, `text.ts`, `unseen.ts`, `memory.ts`, `originals.ts`, `projectmap.ts`, `syntax.ts`, `claims.ts`) |
| `llama_cpp_client.py` | llama-server client and routing policies |
| `repo_indexer.py` | AST symbol scan and function slicing |
| `benchmark_tasks.py` | Benchmark task data |
| `repo_benchmark.py`, `run_full_battery_eval.py`, `benchmark_parallel_slots.py` | Benchmarks |
| `tests/` | Unit tests |

## License

MIT
