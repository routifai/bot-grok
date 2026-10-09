import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";

/**
 * Keys for the Muse edition's bundled 3D illustrations (Microsoft Fluent Emoji, MIT;
 * see NOTICE). One source of truth for the backend (Idea prompt/parser) and the web
 * client (apps/web/src/lib/illustrations.ts), which resolves each key to its PNG.
 */
export const ILLUSTRATION_KEYS = [
  "bank",
  "briefcase",
  "chart-increasing",
  "bar-chart",
  "money-bag",
  "coin",
  "credit-card",
  "dollar-banknote",
  "light-bulb",
  "spiral-calendar",
  "spiral-notepad",
  "clipboard",
  "books",
  "graduation-cap",
  "magnifying-glass",
  "envelope",
  "handshake",
  "laptop",
  "globe",
  "newspaper",
  "bell",
  "trophy",
  "rocket",
  "shield",
  "speech-balloon",
  "house",
] as const;
export const IllustrationKeySchema = z.enum(ILLUSTRATION_KEYS);
export type IllustrationKey = z.infer<typeof IllustrationKeySchema>;

export const IdeaSchema = z.object({
  id: Id,
  /** Short first-person title ("I can keep your $1M goal on a monthly pace"). */
  text: z.string(),
  /** Short grouping label, e.g. "learning" or "travel". */
  area: z.string(),
  /** 1-3 sentence explanation of concretely what the Muse would do. */
  detail: z.string().nullable().optional(),
  /** Illustration for this Idea's row; falls back to an area-keyed default. */
  illustration: IllustrationKeySchema.nullable().optional(),
  createdAt: z.string(),
});
export type Idea = z.infer<typeof IdeaSchema>;

export const ideasContract = {
  ideas: {
    list: oc.input(z.object({ botId: Id })).output(z.array(IdeaSchema)),
    refresh: oc.input(z.object({ botId: Id })).output(z.array(IdeaSchema)),
    /** "Do it": the Idea's message is sent into the Conversation as the person's own. */
    accept: oc.input(z.object({ botId: Id, ideaId: Id })).output(z.object({ ok: z.literal(true) })),
    dismiss: oc
      .input(z.object({ botId: Id, ideaId: Id }))
      .output(z.object({ ok: z.literal(true) })),
  },
};
