import assert from "node:assert/strict";
import { mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SERVERS, modelConfigs, openLog, serverArgs, secondSlot } from "./servers.ts";

test("models use the detected per-slot context", () => {
  const [spark, lfm3] = modelConfigs({ spark: 131072, lfm3: 8192 });
  assert.equal(spark.baseUrl, "http://127.0.0.1:8080/v1");
  assert.equal(spark.contextWindow, 131072);
  assert.equal(spark.maxTokens, 8192);
  assert.equal(lfm3.baseUrl, "http://127.0.0.1:8081/v1");
  assert.equal(lfm3.contextWindow, 8192);
  assert.equal(lfm3.maxTokens, 2048);
});

test("models fall back to the launcher defaults when a server is offline", () => {
  const [spark, lfm3] = modelConfigs({});
  assert.equal(spark.contextWindow, 32768);
  assert.equal(lfm3.contextWindow, 16384);
});

test("thinking is sent as chat template kwargs each template accepts", () => {
  const [spark, lfm3] = modelConfigs({});
  assert.deepEqual(spark.compat, {
    thinkingFormat: "chat-template",
    chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" }, reasoning_effort: { $var: "thinking.effort" } },
  });
  assert.deepEqual(spark.thinkingLevelMap, { minimal: "low", low: "low", medium: "high", high: "high" });
  assert.deepEqual(lfm3.compat, {
    thinkingFormat: "chat-template",
    chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
  });
});

test("server arguments match the launcher defaults", () => {
  assert.deepEqual(serverArgs("spark", {}), [
    "-hf", SERVERS.spark.id, "--host", "127.0.0.1", "--port", "8080",
    "--ctx-size", "131072", "--parallel", "4", "-ngl", "99", "--jinja",
  ]);
  assert.deepEqual(serverArgs("lfm3", {}).slice(0, 10), [
    "-hf", SERVERS.lfm3.id, "--host", "127.0.0.1", "--port", "8081", "--ctx-size", "65536", "--parallel", "4",
  ]);
});

test("SPARK_MODEL and LFM3_MODEL select a local file or another Hugging Face ID", () => {
  assert.deepEqual(serverArgs("spark", { SPARK_MODEL: "/models/spark.gguf" }).slice(0, 2), ["-m", "/models/spark.gguf"]);
  assert.deepEqual(serverArgs("lfm3", { LFM3_MODEL: "org/other-GGUF:Q8_0" }).slice(0, 2), ["-hf", "org/other-GGUF:Q8_0"]);
});

test("logs go to a private directory and are never written through a symlink", (t) => {
  const base = mkdtempSync(join(tmpdir(), "cadre-logs-"));
  const dir = join(base, "cache", "pi-cadre");
  const { path } = openLog(dir, "spark");
  assert.equal(path, join(dir, "pi-cadre-spark.log"));
  if (process.platform !== "win32") {
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  const victim = join(base, "victim.txt");
  writeFileSync(victim, "keep");
  symlinkSync(victim, join(dir, "pi-cadre-lfm3.log"));
  if (process.platform === "win32") return t.skip("O_NOFOLLOW is POSIX-only");
  assert.throws(() => openLog(dir, "lfm3"), /ELOOP|EMLINK/);
});

test("the second slot can hold another small model, each with its own template settings", () => {
  assert.equal(secondSlot(undefined).id, "LiquidAI/LFM3-1.7B-GGUF:Q4_K_M");
  const phi = secondSlot("phi4-mini");
  assert.equal(phi.id, "unsloth/Phi-4-mini-instruct-GGUF:Q4_K_M");
  assert.equal(phi.reasoning, false, "Phi-4-mini has no thinking mode");
  assert.deepEqual(phi.chatTemplateKwargs, {});
  const qwen = secondSlot("qwen3-1.7b");
  assert.equal(qwen.id, "unsloth/Qwen3-1.7B-GGUF:Q4_K_M");
  assert.ok("enable_thinking" in qwen.chatTemplateKwargs);
  assert.throws(() => secondSlot("gpt-9"), /Unknown second model "gpt-9"; known: lfm3, phi4-mini, qwen3-1.7b/);
});
