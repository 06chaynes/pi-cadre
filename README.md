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

The extension registers the `llama-cpp` provider at startup. It reads each server's per-slot context from `/props` and uses the launcher default (Spark 32768, LFM3 2048) for a server that is not running yet. Thinking levels are sent as chat template kwargs: Spark accepts `low` and `high` effort, so Pi's `medium` maps to `high`.

Run `python3 setup_wizard.py --help` for the unattended and dry-run flags.

## Run

```bash
./launchers/start_llama_server.sh       # Windows: launchers\start_llama_server.bat
./launchers/pi_cadre.sh                  # Windows: launchers\pi_cadre.bat; ./pi-cadre is a shortcut
```

`MODEL` in `cadre_config.env` controls both launchers:

| `MODEL` | Server | Pi uses |
|---|---|---|
| `dual` | Spark on 8080 (4 slots x 32k) and LFM3 on 8081 (16 slots x 2k) | Spark |
| `spark` | Spark on 8080 | Spark |
| `lfm3` | LFM3 on 8081 | LFM3 |
| HF repo ID or `.gguf` path | that model on `PORT` (default 8080) | Spark entry on 8080 |

Command-line flags override the config; run `start_llama_server.sh --help` to list them. By default `spark` and `lfm3` download the Q4_K_M quants from Hugging Face. To use local files or other quants, set `SPARK_MODEL` and `LFM3_MODEL` to a `.gguf` path or Hugging Face ID.

On machines with more than one GPU, llama.cpp splits layers across all of them. Add `-- --device <name>` to pin a server to one device; `llama-server --list-devices` lists the names.

With Ollama, start the server with `launchers/start_ollama.sh` (or `.bat`) and run `pi`.

Pi commands added by the extension:

- `/cadre-status`: health, model file, and per-slot context of both servers.
- `/cadre-thinking auto|off|minimal|low|medium|high`: in `auto`, prompts mentioning planning, architecture, diagnosis, debugging, investigation, or review run with medium thinking, and all others run with thinking off.
- `/cadre-guard on|off`: path guard, on by default. Blocks writes and edits outside the working directory, and reads, searches, and bash commands that reach `/` or your home directory outside the working directory. Bash commands are checked by the paths written in them, so it catches mistakes rather than acting as a sandbox.

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
| `pi_extensions/cadre.ts` | Pi extension |
| `llama_cpp_client.py` | llama-server client and routing policies |
| `repo_indexer.py` | AST symbol scan and function slicing |
| `benchmark_tasks.py` | Benchmark task data |
| `repo_benchmark.py`, `run_full_battery_eval.py`, `benchmark_parallel_slots.py` | Benchmarks |
| `tests/` | Unit tests |

## License

MIT
