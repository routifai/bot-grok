// A Helper the Muse started, as a chat block: its `start_helper` call (and the receipt the engine
// answered with, engine/omnigent/omnigent/superchat/helpers/handlers.py `_receipt`) becomes a
// `helper` block that the chat renders as a live row under the hand-off message. The block holds
// only the id and title; progress is read live from the Activity feed. Pure: ./helpers.test.ts.
import type { MessageBlock } from "@aiden/contracts";

const START_HELPER_TOOL = "start_helper";

type Item = Record<string, unknown>;
export type HelperBlock = Extract<MessageBlock, { kind: "helper" }>;

/** The engine's tool name may arrive bare or behind a harness prefix (`mcp__omnigent__...`). */
export function isStartHelperCall(item: Item): boolean {
  return (
    item.type === "function_call" &&
    typeof item.name === "string" &&
    (item.name === START_HELPER_TOOL || item.name.endsWith(`__${START_HELPER_TOOL}`))
  );
}

/** A finished `start_helper` call -> its block. A refused call (the engine answered
 * `Error: ...`) or one still running has no Helper to show, so it renders nothing. */
export function helperBlockFromToolCall(output: string | undefined): HelperBlock | null {
  if (!output) return null;
  let receipt: unknown;
  try {
    receipt = JSON.parse(output);
  } catch {
    return null;
  }
  if (!receipt || typeof receipt !== "object") return null;
  const { started, helper_id: helperId, title } = receipt as Record<string, unknown>;
  if (started !== true || typeof helperId !== "string" || !helperId) return null;
  return { kind: "helper", helperId, title: typeof title === "string" ? title : "" };
}
