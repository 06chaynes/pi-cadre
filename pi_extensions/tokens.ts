/**
 * Token counts from each model's own tokenizer (llama-server /tokenize). Characters per token vary too much to guess:
 * a web search result of Wikipedia tables ran 1.79 characters per token on Spark and 2.57 on LFM3, while prose runs
 * about 4.
 */

import { type ServerKey, serverUrl } from "./servers.ts";

// Used when a server does not answer; denser than any text measured, so the estimate errs high.
const FALLBACK_CHARS_PER_TOKEN = 1.5;

/** Tokens in `text` on the server's tokenizer, or an upper estimate when the server does not answer. */
export async function countTokens(key: ServerKey, text: string): Promise<number> {
  try {
    const res = await fetch(`${serverUrl(key)}/tokenize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const body = await res.json();
      if (Array.isArray(body.tokens)) return body.tokens.length;
    }
  } catch {
    // Fall through to the estimate.
  }
  return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN);
}

/**
 * Tokens in an OpenAI-style chat request as the server will see it: its chat template applied to the messages and
 * tools (llama-server /apply-template), then tokenized. Falls back to counting the request's JSON.
 */
export async function requestTokens(key: ServerKey, payload: { messages?: unknown; tools?: unknown; chat_template_kwargs?: unknown }): Promise<number> {
  const { messages, tools, chat_template_kwargs } = payload;
  try {
    const res = await fetch(`${serverUrl(key)}/apply-template`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, tools, chat_template_kwargs }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const body = await res.json();
      if (typeof body.prompt === "string") return countTokens(key, body.prompt);
    }
  } catch {
    // Fall through to the estimate.
  }
  return countTokens(key, JSON.stringify({ messages, tools }));
}

/** Text of a conversation: string contents and text blocks as written, other blocks (tool calls, thinking) as JSON. */
export function conversationText(messages: readonly any[]): string {
  return messages.map(messageText).join("\n");
}

/** A message's text; a system message adds its sections (preamble, tools, ...) as Pi's getSystemMessageText does. */
function messageText(message: any): string {
  const content = message?.content;
  const body =
    typeof content === "string"
      ? content
      : (content ?? []).map((block: any) => (typeof block?.text === "string" ? block.text : JSON.stringify(block))).join("\n");
  if (message?.role !== "system") return body;
  const sections = Object.values(message.sections ?? {}).filter((text): text is string => typeof text === "string");
  return [body, ...sections].filter((part) => part.length > 0).join("\n\n");
}
