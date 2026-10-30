# Changelog

All notable changes to pi-cadre will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to pre-1.0 semver (minor-version bumps may include breaking changes).

## [Unreleased]

## [0.1.1]

### Added

- Path guard, on by default. Blocks writes and edits outside the working directory, and reads, searches, and bash commands that reach the filesystem root or the home directory outside the working directory. `/cadre-guard off` turns it off for the session. In testing, Spark's first command in a sandbox was `cd` into an unrelated repo under the home directory; the guard blocked it and Spark returned to the project.

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
