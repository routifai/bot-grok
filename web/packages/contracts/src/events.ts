import * as z from "zod";
import { Id } from "./ids.js";
import { ReplyCardBlock } from "./reply-cards.js";

export const ProductEventType = z.enum([
  "thread.message.created",
  "thread.cleared",
  "thread.message.updated",
  "thread.message.reaction",
  "thread.progress",
  "thread.artifact",
  "thread.ask",
  "thread.choice",
  "thread.meta",
  "thread.computer",
  "thread.subagent",
  "thread.cloud_agent",
  "run.started",
  "run.checkpointed",
  "run.waiting_input",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "computer.status",
  "memory.revised",
  "routine.created",
  "routine.updated",
  "routine.fired",
  "effect.recorded",
  "agent.tool.called",
  "agent.tool.completed",
  "effect.reconciled",
  "usage.recorded",
]);
export type ProductEventType = z.infer<typeof ProductEventType>;

export const MessageRole = z.enum(["user", "bot", "system"]);

export const SecretAskPurpose = z.enum(["otp", "password", "api_key"]);
export type SecretAskPurpose = z.infer<typeof SecretAskPurpose>;

export const MessageBlock = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({
    kind: z.literal("card"),
    lines: z.array(z.object({ k: z.string(), v: z.string() })),
  }),
  z.object({
    kind: z.literal("ask"),
    text: z.string(),
    approvalEffectId: Id.optional(),
    detail: z.string().optional(),
    input: z.enum(["text", "secret"]).optional(),
    /** Why the secret is needed; drives field label on the masked card. */
    purpose: SecretAskPurpose.optional(),
    /** Where a secret goes: the card shows the origin, and a `login` also asks for a username. */
    credential: z.object({ origin: z.string(), auth: z.object({ type: z.string() }) }).optional(),
    status: z.enum(["pending", "answered"]).optional(),
    answer: z.string().optional(),
    actions: z
      .array(
        z.object({
          id: z.string(),
          label: z.string(),
          outcome: z.enum(["created", "cancelled"]).optional(),
        }),
      )
      .optional(),
    /**
     * Muse edition: set when the Muse offers to save something it just did as a reusable
     * skill (`offer_skill`). Answering "save" creates the agent skill from this SKILL.md;
     * `asks.answer` routes on it instead of `answerRunInput`.
     */
    skillOffer: z
      .object({
        name: z.string().max(80),
        description: z.string().max(2000),
        content: z.string().max(100_000),
      })
      .optional(),
  }),
  z.object({ kind: z.literal("meta"), text: z.string() }),
  z.object({
    /** A turn that failed or was cut short. The engine sends a code, never wording; the client
        maps it to its own short copy. */
    kind: z.literal("error"),
    code: z.string(),
    level: z.literal("info").optional(),
  }),
  z.object({
    kind: z.literal("progress"),
    text: z.string(),
    /** Provider-generated tool status rather than assistant-authored narration. */
    activity: z.literal(true).optional(),
    pendingToolNames: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal("steps"),
    steps: z.array(z.object({ label: z.string(), count: z.number().int().positive() })),
    durationMs: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("subagent"),
    agentId: z.string(),
    name: z.string(),
    task: z.string(),
    status: z.enum(["running", "completed", "failed"]),
    progress: z.string().optional(),
    result: z.string().optional(),
  }),
  z.object({
    /** A Helper the Muse started (CONTEXT.md "Helper"): a live row under the hand-off message.
        Only the id and a fallback title travel here; its progress is read live from the Activity
        feed (`helperId` is the Helper's chat id, an Activity's `chatId`). */
    kind: z.literal("helper"),
    helperId: z.string(),
    title: z.string(),
  }),
  z.object({
    /** Compact card for a remote cloud coding agent (not the bot computer). */
    kind: z.literal("cloud_agent"),
    agentId: z.string(),
    title: z.string(),
    status: z.enum(["running", "finished", "failed", "cancelled"]),
    url: z.string(),
    branch: z.string().optional(),
    prUrl: z.string().optional(),
    latestRunId: z.string().optional(),
  }),
  /** The Muse's `render_card` result (web/packages/contracts/src/reply-cards.ts). */
  ReplyCardBlock,
  z.object({
    kind: z.literal("image"),
    artifactId: Id,
    mimeType: z.string(),
    name: z.string(),
  }),
  z.object({
    kind: z.literal("file"),
    artifactId: Id,
    mimeType: z.string(),
    name: z.string(),
    size: z.number().int().nonnegative(),
  }),
]);
export type MessageBlock = z.infer<typeof MessageBlock>;

export const ProductEventSchema = z.object({
  id: Id,
  threadId: Id,
  botId: Id,
  seq: z.number().int().nonnegative(),
  type: ProductEventType,
  runId: Id.optional(),
  createdAt: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type ProductEvent = z.infer<typeof ProductEventSchema>;

export const ThreadMessageSchema = z.object({
  id: Id,
  threadId: Id,
  seq: z.number().int().nonnegative(),
  role: MessageRole,
  blocks: z.array(MessageBlock),
  botId: Id.optional(),
  replyToMessageId: Id.optional(),
  replyQuote: z.string().optional(),
  runId: Id.optional(),
  createdAt: z.string(),
  /** `chats.transcript` only: `queued` while this message waits behind the running turn. */
  delivered: z.literal("queued").optional(),
});
export type ThreadMessage = z.infer<typeof ThreadMessageSchema>;
