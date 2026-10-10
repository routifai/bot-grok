import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";

export const SignupModeSchema = z.enum(["closed", "invite", "domain", "approval", "open"]);

export const SignupSettingsSchema = z.object({
  mode: SignupModeSchema,
  /** Invite list: addresses (or `@domain` entries) allowed to register in `invite` mode. */
  invites: z.array(z.string()),
  /** Domains allowed to register in `domain` mode. */
  domains: z.array(z.string()),
});
export type SignupSettings = z.infer<typeof SignupSettingsSchema>;

export const PendingSignupSchema = z.object({
  userId: Id,
  email: z.string(),
  name: z.string(),
  /** False when the mailbox was never proved (no email provider, or not yet verified). */
  emailVerified: z.boolean(),
  /** Set while a previous space is kept, detached, for the deployment owner to restore or discard. */
  previousSpace: z
    .object({ createdAt: z.string(), lastActive: z.string().nullable(), muses: z.number() })
    .nullable(),
  createdAt: z.string(),
});
export type PendingSignup = z.infer<typeof PendingSignupSchema>;

const ok = z.object({ ok: z.literal(true) });

// Deployment owner only: who may join, and who is waiting.
export const signupsContract = {
  signups: {
    settings: oc.output(SignupSettingsSchema),
    update: oc.input(SignupSettingsSchema.partial()).output(SignupSettingsSchema),
    pending: oc.output(z.array(PendingSignupSchema)),
    approve: oc.input(z.object({ userId: Id })).output(ok),
    reject: oc.input(z.object({ userId: Id })).output(ok),
    /** Re-attach the previous space and let the person in (they are confirmed as the same person). */
    restore: oc.input(z.object({ userId: Id })).output(ok),
    /** Purge the kept space now. */
    discard: oc.input(z.object({ userId: Id })).output(ok),
  },
};
