# AGENTS.md

Pi coding agent + local llama.cpp models (Spark-X2.6-4B on port 8080, LFM3-1.7B on port 8081). README.md covers usage; this file covers what you need to change the code.

## Map

- `setup_wizard.py`: installer. Writes `cadre_config.env` (value lines only, keeps comments), adds the repo to `packages` in `~/.pi/agent/settings.json`, and adds `lfm3:latest` to the Ollama provider in `models.json`.
- `cadre_config.env`: single source of server settings. Read by every launcher in `launchers/`. `SPARK_MODEL` and `LFM3_MODEL` hold machine-specific model paths. Don't commit local values.
- `launchers/start_llama_server.{sh,bat}`: `MODEL=dual|spark|lfm3|<HF id>|<.gguf>`. Each model always uses its own port: Spark 8080, LFM3 8081. Dual mode re-invokes the script once per model.
- `launchers/pi_cadre.{sh,bat}`: starts Pi on the configured model.
- `package.json`: makes the repo a Pi package. `files` limits the npm package to the extension. Releases: bump `version`, update `CHANGELOG.md`, push a `vX.Y.Z` tag; `.github/workflows/release.yml` stages the release on npm via trusted publishing, and a maintainer approves it with 2FA.
- `pi_extensions/cadre.ts`: registers the `llama-cpp` provider (per-slot context from `/props`, thinking as chat template kwargs), `/cadre-status`, `/cadre-thinking`, per-prompt thinking level, coding rules appended to the system message. Pi API docs are in the installed package's `docs/extensions.md` and `docs/custom-provider.md`.
- `llama_cpp_client.py`: `MODELS` (ids, URLs), `AutoThinkingPolicy`, `AutoModelPolicy`, `LlamaCppClient`. `generate_code` holds the only copy of the Spark-chat vs LFM3-prefill logic.
- `repo_indexer.py`: AST symbol scan and function slicing.
- `benchmark_tasks.py`: task data and the inject/verify/reset helpers for the `requests_repo/` clone (psf/requests v2.31.0, gitignored).
- `repo_benchmark.py`, `run_full_battery_eval.py`, `benchmark_parallel_slots.py`: benchmarks. They need running servers and write to `results/` (gitignored).

## Commands

```bash
python3 -m pytest                      # unit tests, no server needed
node --test 'pi_extensions/*.test.ts'  # extension tests, Node 22.6+
python3 run_full_battery_eval.py       # needs llama-server and requests_repo/ (see README)
./launchers/start_llama_server.sh -h
```

CI (`.github/workflows/test.yml`) runs pytest on Linux/macOS/Windows with Python 3.9 and 3.13, the extension tests on Node 24, and shellcheck on the shell scripts.

## Rules

- No emojis, marketing language, or narrating comments. Comments describe what code does and how to use it.
- No duplication: shared logic lives in one place (`MODELS`, `generate_code`, `benchmark_tasks`). Keep the `.sh` and `.bat` launchers behaviorally identical.
- No unused code paths or parameters. Remove anything without a caller.
- Python 3.9 compatible. Standard library only outside tests.
- Pi custom providers need an `apiKey`, even for local servers. The wizard sets `"none"`.
- Model and port facts (ids, 8080/8081, default context pools) appear in `llama_cpp_client.py`, `setup_wizard.py`, the launchers, `cadre_config.env`, and the extension. Change them together.
- Benchmark task descriptions contain the expected fix. Do not report suite pass rates as model capability.
