import { eventIterator, oc } from "@orpc/contract";
import * as z from "zod";
import { ATTACHMENT_MAX_COUNT } from "../attachments.js";
import {
  REPLY_QUOTE_MAX_LENGTH,
  ThreadMessagePageSchema,
  ThreadSnapshotSchema,
} from "../domain.js";
import { ProductEventSchema } from "../events.js";
import { Id } from "../ids.js";
import { MessageReactionSchema } from "../reactions.js";

import { threadTarget } from "./shared.js";

const structuredMentionTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bot"), id: Id }),
  z.object({ kind: z.literal("group"), id: Id }),
  z.object({ kind: z.literal("routine"), id: Id }),
  z.object({ kind: z.literal("connector"), id: Id }),
]);

const threadSendInput = threadTarget
  .safeExtend({
    text: z.string().optional(),
    artifactIds: z.array(Id).max(ATTACHMENT_MAX_COUNT).optional(),
    /** Bare bot ids (legacy) or typed mention chips from the composer. */
    mentions: z
      .array(z.union([Id, structuredMentionTarget]))
      .max(64)
      .optional(),
    replyToMessageId: Id.optional(),
    replyQuote: z.string().trim().min(1).max(REPLY_QUOTE_MAX_LENGTH).optional(),
    clientNonce: z.string().min(1).max(200).optional(),
  })
  .superRefine((input, ctx) => {
    const text = input.text?.trim() ?? "";
    const artifactIds = input.artifactIds ?? [];
    if (!text && artifactIds.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "Provide text or at least one attachment",
        path: ["text"],
      });
    }
    if (input.replyQuote && !input.replyToMessageId) {
      ctx.addIssue({
        code: "custom",
        message: "replyQuote requires replyToMessageId",
        path: ["replyQuote"],
      });
    }
  });

export const threadsContract = {
  threads: {
    head: oc.input(threadTarget).output(
      z.object({
        threadId: Id,
        cursor: z.number().int().min(-1),
      }),
    ),
    get: oc.input(threadTarget).output(ThreadSnapshotSchema),
    messages: oc
      .input(
        threadTarget.safeExtend({
          before: z.number().int().nonnegative().optional(),
          includePeerRuns: z.boolean().optional(),
          includePeerReceipts: z.boolean().optional(),
          around: z
            .object({
              messageId: Id.optional(),
              seq: z.number().int().nonnegative().optional(),
            })
            .optional(),
        }),
      )
      .output(ThreadMessagePageSchema),
    subscribe: oc
      .input(threadTarget.safeExtend({ cursor: z.number().int().min(-1) }))
      .output(eventIterator(ProductEventSchema)),
    send: oc.input(threadSendInput).output(
      z.object({
        taskId: Id,
        runId: Id,
        seq: z.number().int(),
        runIds: z.array(Id).optional(),
      }),
    ),
    react: oc
      .input(
        threadTarget.safeExtend({
          messageId: Id,
          reaction: MessageReactionSchema,
          clientNonce: z.string().min(1).max(200),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    stop: oc.input(threadTarget).output(z.object({ ok: z.literal(true) })),
    followUp: oc
      .input(threadTarget.safeExtend({ text: z.string().min(1) }))
      .output(z.object({ ok: z.literal(true) })),
    clear: oc.input(threadTarget).output(z.object({ ok: z.literal(true) })),
    answer: oc
      .input(
        threadTarget.safeExtend({
          runId: Id,
          messageId: Id,
          answer: z.string().min(1),
          /** Only for a login card; `answer` carries its password. */
          username: z.string().min(1).max(512).optional(),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    markRead: oc.input(threadTarget).output(z.object({ ok: z.literal(true) })),
    markUnread: oc.input(threadTarget).output(z.object({ ok: z.literal(true) })),
  },
};
