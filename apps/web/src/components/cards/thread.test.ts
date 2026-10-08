import type { ReplyCardBlock, ThreadMessage } from "@nova/contracts";
import { expect, it } from "vitest";
import { replyCardKey, resolveReplyCards } from "./thread";

const card = (id: string | undefined, over: Partial<ReplyCardBlock> = {}): ReplyCardBlock => ({
  kind: "reply_card",
  card: "progress",
  id,
  data: { label: "Import", value: 10, status: "running" },
  fallback: "Import 10%",
  ...over,
});
let seq = 0;
const message = (
  role: "bot" | "user",
  ...blocks: ThreadMessage["blocks"]
): ThreadMessage & { id: string } => {
  seq += 1;
  return {
    id: `m${seq}`,
    threadId: "t",
    seq,
    role,
    blocks,
    createdAt: new Date(seq * 1000).toISOString(),
  };
};

it("shows the latest data of a reused id at the first card's position and hides the rest", () => {
  const first = message("bot", card("p1"));
  const reply = message("user", { kind: "text", text: "ok" });
  const update = message(
    "bot",
    card("p1", { data: { label: "Import", value: 80, status: "running" } }),
  );
  const resolved = resolveReplyCards([first, reply, update]);
  expect(resolved.get(replyCardKey(first.id, 0))?.block?.data).toMatchObject({ value: 80 });
  expect(resolved.get(replyCardKey(update.id, 0))?.block).toBeNull();
});

it("keeps the finished card while an update is still pending", () => {
  const first = message("bot", card("p1"));
  const pending = message("bot", card("p1", { pending: true, data: {} }));
  const resolved = resolveReplyCards([first, pending]);
  expect(resolved.get(replyCardKey(first.id, 0))?.block?.pending).toBeUndefined();
});

it("leaves cards without an id alone", () => {
  const a = message("bot", card(undefined), card(undefined));
  const resolved = resolveReplyCards([a]);
  expect([...resolved.values()].every((entry) => entry.block !== null)).toBe(true);
});

it("takes the person's next message as the answer", () => {
  const ask = message("bot", card("a1", { card: "ask" }));
  const unanswered = resolveReplyCards([ask]);
  expect(unanswered.get(replyCardKey(ask.id, 0))?.answer).toBeUndefined();
  const reply = message("user", { kind: "text", text: " Berlin " });
  expect(resolveReplyCards([ask, reply]).get(replyCardKey(ask.id, 0))?.answer).toBe("Berlin");
});
