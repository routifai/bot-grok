// Persisting thread messages produced during a run: redacting secrets from blocks
// before they are stored, and writing the message + its event in one transaction.
import type { MessageBlock } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import { appendEventInTransaction, createThreadMessageInTransaction } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./types.js";

export function redactBlocks(blocks: MessageBlock[], secrets: string[]): MessageBlock[] {
  return blocks.map((block) => {
    if (block.kind === "text") {
      return { kind: "text" as const, text: redactSecrets(block.text, secrets) };
    }
    if (block.kind === "bot_message_sent" || block.kind === "bot_message_received") {
      return { ...block, text: redactSecrets(block.text, secrets) };
    }
    return block;
  });
}

export async function publishMessage(
  deps: ExecutorDeps,
  run: { id: string; spaceId: string; threadId: string; botId: string },
  role: "user" | "bot" | "system",
  blocks: MessageBlock[],
  markUnread?: boolean,
  clientNonce?: string,
) {
  const committed = await deps.prisma.$transaction((tx) =>
    persistMessageInTransaction(tx, run, role, blocks, markUnread, clientNonce),
  );
  await deps.events.notify(run.threadId, committed.eventSeq).catch((error) => {
    getLogger().error("thread message realtime notification", error);
  });
  return committed.message;
}

export async function persistMessageInTransaction(
  tx: Prisma.TransactionClient,
  run: { id: string; spaceId: string; threadId: string; botId: string },
  role: "user" | "bot" | "system",
  blocks: MessageBlock[],
  markUnread?: boolean,
  clientNonce?: string,
) {
  const message = await createThreadMessageInTransaction(tx, {
    threadId: run.threadId,
    role,
    blocks,
    botId: run.botId,
    runId: run.id,
    markUnread,
    clientNonce,
  });
  const event = await appendEventInTransaction(tx, {
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    type: "thread.message.created",
    runId: run.id,
    payload: { messageId: message.id, role, blocks },
  });
  return { message, eventSeq: event.seq };
}
