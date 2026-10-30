import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { conversationText, countTokens } from "./tokens.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("countTokens uses the server's tokenizer", async () => {
  let body = "";
  globalThis.fetch = (async (url: string, init: any) => {
    assert.equal(url, "http://127.0.0.1:8080/tokenize");
    body = init.body;
    return new Response(JSON.stringify({ tokens: [1, 2, 3, 4, 5, 6, 7] }));
  }) as typeof fetch;
  assert.equal(await countTokens("spark", "2^136279841 - 1"), 7);
  assert.deepEqual(JSON.parse(body), { content: "2^136279841 - 1" });
});

test("countTokens falls back to 1.5 characters per token when the server does not answer", async () => {
  globalThis.fetch = (async () => {
    throw new Error("connection refused");
  }) as typeof fetch;
  assert.equal(await countTokens("lfm3", "x".repeat(300)), 200);
});

test("conversationText joins every message's text, and other blocks as JSON", () => {
  const text = conversationText([
    { role: "system", content: "rules" },
    { role: "user", content: [{ type: "text", text: "question" }] },
    { role: "assistant", content: [{ type: "toolCall", name: "web_search", arguments: { query: "q" } }] },
    { role: "toolResult", content: [{ type: "text", text: "result" }] },
  ]);
  assert.match(text, /rules[\s\S]*question[\s\S]*"web_search"[\s\S]*result/);
});

test("system messages count their sections, as Pi's getSystemMessageText joins them", () => {
  const system = { role: "system", content: "", sections: { preamble: "p".repeat(70), tools: "t".repeat(35), unset: null }, timestamp: 1 };
  assert.match(conversationText([system]), /^p{70}\n\nt{35}$/);
});
