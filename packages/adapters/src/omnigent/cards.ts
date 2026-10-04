// Reply cards on the Omnigent side: the Muse's `render_card` tool call (a `function_call` item
// plus its `function_call_output`) becomes a `reply_card` message block. The engine validated
// the payload and echoed it back as `{"type":"card", ...}` (engine/omnigent/omnigent/tools/
// builtins/render_card.py); a call without an output yet is a pending card (skeleton). Pure:
// no network, so ./cards.test.ts exercises it directly.
import type { MessageBlock, ReplyCardBlock } from "@aiden/contracts";
import { redactSecrets } from "@aiden/core";

const RENDER_CARD_TOOL = "render_card";
const VAULT_REQUEST_TOOL = "vault_request_secret";

type Item = Record<string, unknown>;

/** The engine's tool name may arrive bare or behind a harness prefix (`mcp__omnigent__...`). */
export function isRenderCardCall(item: Item): boolean {
  return (
    item.type === "function_call" &&
    typeof item.name === "string" &&
    (item.name === RENDER_CARD_TOOL || item.name.endsWith(`__${RENDER_CARD_TOOL}`))
  );
}

/** The Muse's `vault_request_secret` call: it asks the person for a login. */
export function isVaultRequestCall(item: Item): boolean {
  return (
    item.type === "function_call" &&
    typeof item.name === "string" &&
    (item.name === VAULT_REQUEST_TOOL || item.name.endsWith(`__${VAULT_REQUEST_TOOL}`))
  );
}

function parseObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** `call_id` -> output text for every `function_call_output` in `items`. */
export function toolOutputsByCallId(items: Item[]): Map<string, string> {
  const outputs = new Map<string, string>();
  for (const item of items) {
    if (item.type === "function_call_output" && typeof item.call_id === "string") {
      outputs.set(item.call_id, typeof item.output === "string" ? item.output : "");
    }
  }
  return outputs;
}

function cardBlock(payload: Record<string, unknown>): ReplyCardBlock | null {
  const { card, id, title, data, fallback } = payload;
  if (typeof card !== "string" || typeof fallback !== "string" || !fallback.trim()) return null;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return {
    kind: "reply_card",
    card,
    ...(typeof id === "string" && id ? { id } : {}),
    ...(typeof title === "string" && title ? { title } : {}),
    data: data as Record<string, unknown>,
    fallback: fallback.trim(),
  };
}

/**
 * One `render_card` call -> its block. `output` is the paired tool output text, or `undefined`
 * while the call is still running. Returns `null` when the call failed (the engine returned an
 * error and the model will retry or answer in prose), so nothing broken is ever shown.
 */
export function replyCardFromToolCall(
  call: Item,
  output: string | undefined,
): ReplyCardBlock | null {
  if (output === undefined) {
    const args = parseObject(call.arguments);
    const pending = args && cardBlock({ ...args, data: {} });
    return pending ? { ...pending, pending: true } : null;
  }
  const result = parseObject(output);
  return result?.type === "card" ? cardBlock(result) : null;
}

/** A finished `vault_request_secret` -> its secure-entry card. Only the request id and what is
 * being asked for travel in chat; the engine never returns a value. */
export function secureEntryFromToolCall(output: string | undefined): ReplyCardBlock | null {
  const nested = output === undefined ? undefined : parseObject(output)?.secure_entry;
  const { id, name, site, reason } = (nested && typeof nested === "object" ? nested : {}) as Record<
    string,
    unknown
  >;
  if (typeof id !== "string" || typeof name !== "string" || typeof site !== "string") return null;
  return {
    kind: "reply_card",
    card: "secure_entry",
    data: { requestId: id, name, site, ...(typeof reason === "string" ? { reason } : {}) },
    fallback: `Nova needs a login for ${site}. Open this chat in Nova to enter it securely.`,
  };
}

/** The card a Muse tool call renders, or `null` for any other item (or a failed call). */
export function cardFromToolCall(call: Item, outputs: Map<string, string>): ReplyCardBlock | null {
  const callId = typeof call.call_id === "string" ? call.call_id : "";
  if (isRenderCardCall(call)) return replyCardFromToolCall(call, outputs.get(callId));
  if (isVaultRequestCall(call)) return secureEntryFromToolCall(outputs.get(callId));
  return null;
}

/** A card never carries a secret: one that does degrades to its redacted markdown fallback. */
export function redactReplyCard(block: ReplyCardBlock, secrets: string[]): MessageBlock {
  const serialized = JSON.stringify(block);
  if (redactSecrets(serialized, secrets) === serialized) return block;
  return { kind: "text", text: redactSecrets(block.fallback, secrets) };
}

/**
 * The blocks of one Super Chat turn: every card the Muse rendered, in order, with `replyText`
 * (the turn's final reply) at the position of the last assistant message. Earlier narration
 * stays dropped, as before cards existed.
 */
export function turnBlocks(items: Item[], replyText: string): MessageBlock[] {
  const outputs = toolOutputsByCallId(items);
  let replyIndex = -1;
  items.forEach((item, index) => {
    if (item.type === "message" && item.role === "assistant") replyIndex = index;
  });
  const blocks: MessageBlock[] = [];
  let replied = false;
  items.forEach((item, index) => {
    if (index === replyIndex && replyText) {
      blocks.push({ kind: "text", text: replyText });
      replied = true;
    } else {
      const block = cardFromToolCall(item, outputs);
      if (block && !block.pending) blocks.push(block);
    }
  });
  if (replyText && !replied) blocks.push({ kind: "text", text: replyText });
  return blocks;
}
