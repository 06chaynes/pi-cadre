import assert from "node:assert/strict";
import { test } from "node:test";

import { chooseModel, promptText, routeRequest } from "./router.ts";

test("questions and single-spot edits go to LFM3", () => {
  for (const prompt of [
    "What does Inventory.available in inventory/store.py return? Answer in one sentence.",
    "Where is the reservation released?",
    "Explain how reserve works",
    "Why does test_commit_ships_reserved_units fail?",
    "Add a one-line docstring to the add method in inventory/store.py.",
    "Fix the typo in the README heading",
    "Rename the variable qty to quantity in reserve",
  ]) {
    assert.equal(chooseModel(prompt), "lfm3", prompt);
  }
});

test("multi-step and open-ended work goes to Spark", () => {
  for (const prompt of [
    "The test test_commit_ships_reserved_units in tests/test_store.py fails. Diagnose the root cause, fix it in inventory/store.py, and run python3 -m pytest -q to confirm all tests pass.",
    "Add a method restock_report(self, threshold) to Inventory in inventory/store.py that returns a sorted list of SKUs whose available quantity is below threshold. Add tests for it in tests/test_store.py, then run python3 -m pytest -q.",
    "Review inventory/store.py for edge cases where the inventory can end up in an invalid state.",
    "Explain how reserve works and then refactor it",
    "Add a docstring to every method and write tests",
    "Implement caching",
    "What should we change to support multiple warehouses? Plan the migration.",
    "x".repeat(400) + "?",
  ]) {
    assert.equal(chooseModel(prompt), "spark", prompt.slice(0, 60));
  }
});

test("prompts that are ambiguous between a question and a change go to Spark", () => {
  // "add" here names a method, but the router cannot tell; sending a question to Spark only costs speed.
  assert.equal(chooseModel("What does add do?"), "spark");
});

test("promptText reads the last user message in string or block form", () => {
  assert.equal(promptText([{ role: "user", content: "first" }, { role: "assistant", content: [] }, { role: "user", content: "second" }]), "second");
  assert.equal(promptText([{ role: "user", content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }]), "a\nb");
  assert.equal(promptText([{ role: "system", content: "s" }]), "");
});

const spark = { id: "spark" } as any;
const lfm3 = { id: "lfm3" } as any;
const request = (extra: Record<string, unknown>) =>
  ({ thinkingLevel: "medium", messages: [{ role: "user", content: "What does reserve do?" }], ...extra }) as any;

test("a user request picks a model from the prompt and keeps the selected thinking level", () => {
  assert.deepEqual(routeRequest(request({ reason: "user" }), { spark, lfm3 }), { model: lfm3, thinkingLevel: "medium" });
  const heavy = request({ reason: "user", messages: [{ role: "user", content: "Implement caching" }] });
  assert.deepEqual(routeRequest(heavy, { spark, lfm3 }), { model: spark, thinkingLevel: "medium" });
});

test("continuations stay on the model that handled the turn", () => {
  const previous = { model: lfm3, thinkingLevel: "low" };
  assert.deepEqual(routeRequest(request({ reason: "continuation", previous }), { spark, lfm3 }), { model: lfm3, thinkingLevel: "low" });
});

test("a failed LFM3 request retries on Spark", () => {
  const failed = { model: lfm3, thinkingLevel: "off", message: {} };
  assert.deepEqual(routeRequest(request({ reason: "retry", failed }), { spark, lfm3 }), { model: spark, thinkingLevel: "off" });
  const sparkFailed = { model: spark, thinkingLevel: "high", message: {} };
  assert.deepEqual(routeRequest(request({ reason: "retry", failed: sparkFailed }), { spark, lfm3 }), { model: spark, thinkingLevel: "high" });
});

test("direct requests and an unavailable LFM3 go to Spark", () => {
  assert.equal(routeRequest(request({ reason: "direct" }), { spark, lfm3 }).model, spark);
  assert.equal(routeRequest(request({ reason: "user" }), { spark }).model, spark);
  const previous = { model: lfm3, thinkingLevel: "low" };
  assert.equal(routeRequest(request({ reason: "continuation", previous }), { spark }).model, spark);
});
