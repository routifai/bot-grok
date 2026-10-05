// Reply cards on the Omnigent side: the Muse's `render_card` tool call (a `function_call` item
// plus its `function_call_output`) becomes a `reply_card` message block. The engine validated
// the payload and echoed it back as `{"type":"card", ...}` (engine/omnigent/omnigent/tools/
// builtins/render_card.py); a call without an output yet is a pending card (skeleton). Pure:
// no network, so ./cards.test.ts exercises it directly.
import type { MessageBlock, ReplyCardBlock } from "@aiden/contracts";
import { redactSecrets } from "@aiden/core";
import { helperBlockFromToolCall, isStartHelperCall } from "./helpers.js";

const RENDER_CARD_TOOL = "render_card";
const VAULT_REQUEST_TOOL = "vault_request_secret";
const ARTIFACT_SAVE_TOOL = "artifact_save";

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

/** The Muse's `artifact_save` call: it saved a deliverable file into the Conversation. */
export function isArtifactSaveCall(item: Item): boolean {
  return (
    item.type === "function_call" &&
    typeof item.name === "string" &&
    (item.name === ARTIFACT_SAVE_TOOL || item.name.endsWith(`__${ARTIFACT_SAVE_TOOL}`))
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

/** A finished `artifact_save` -> its `file` card (Open previews it in Nova, Download saves it).
 * A failed save (the engine returned `{"error"}`) renders nothing; the Muse retries or says so. */
export function fileCardFromArtifactSave(output: string | undefined): ReplyCardBlock | null {
  const saved = output === undefined ? null : parseObject(output);
  if (!saved || saved.type !== "artifact") return null;
  const { id, name, title, kind, size, version, versions } = saved;
  if (typeof id !== "string" || typeof name !== "string") return null;
  const label = typeof title === "string" && title ? title : name;
  const revision = typeof version === "number" && version > 1 ? ` (version ${version})` : "";
  return {
    kind: "reply_card",
    card: "file",
    id: `artifact:${id}`,
    data: {
      name,
      artifactId: id,
      ...(typeof kind === "string" ? { kind } : {}),
      ...(typeof size === "number" ? { size } : {}),
      ...(typeof version === "number" ? { version } : {}),
      ...(typeof versions === "number" ? { versions } : {}),
    },
    fallback: `Saved **${label}**${revision}. Open it in Nova's Library.`,
  };
}

/** The card a Muse tool call renders, or `null` for any other item (or a failed call). */
export function cardFromToolCall(call: Item, outputs: Map<string, string>): ReplyCardBlock | null {
  const callId = typeof call.call_id === "string" ? call.call_id : "";
  if (isRenderCardCall(call)) return replyCardFromToolCall(call, outputs.get(callId));
  if (isVaultRequestCall(call)) return secureEntryFromToolCall(outputs.get(callId));
  if (isArtifactSaveCall(call)) return fileCardFromArtifactSave(outputs.get(callId));
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
 * stays dropped, as before cards existed. The Helpers it started follow last, so their live
 * rows sit right under the hand-off message.
 */
export function turnBlocks(items: Item[], replyText: string): MessageBlock[] {
  const outputs = toolOutputsByCallId(items);
  let replyIndex = -1;
  items.forEach((item, index) => {
    if (item.type === "message" && item.role === "assistant") replyIndex = index;
  });
  const blocks: MessageBlock[] = [];
  const helpers: MessageBlock[] = [];
  const seenCalls = new Set<string>();
  let replied = false;
  items.forEach((item, index) => {
    // A turn's streamed output can repeat a tool call; one call is one block.
    if (item.type === "function_call" && typeof item.call_id === "string") {
      if (seenCalls.has(item.call_id)) return;
      seenCalls.add(item.call_id);
    }
    if (index === replyIndex && replyText) {
      blocks.push({ kind: "text", text: replyText });
      replied = true;
    } else if (isStartHelperCall(item)) {
      const helper = helperBlockFromToolCall(outputs.get(String(item.call_id ?? "")));
      if (helper) helpers.push(helper);
    } else {
      const block = cardFromToolCall(item, outputs);
      if (block && !block.pending) blocks.push(block);
    }
  });
  if (replyText && !replied) blocks.push({ kind: "text", text: replyText });
  return [...blocks, ...helpers];
}
