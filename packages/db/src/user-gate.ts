import { unverifiedAccessAllowed } from "@nova/core";
import type { PrismaClient } from "./client.js";

/** What this process knows about mail delivery; the stored signup mode is read from the database. */
export interface UserGateRule {
  hasEmailDelivery: boolean;
  /** The personal-install escape hatch, already false on a hosted deployment. */
  devFlagAllowed: boolean;
}

/**
 * Whether a person may act right now: background jobs, messaging, streams, the screen proxy and
 * published-app viewing all ask this. Active, and either their mailbox is proved or nothing can
 * prove one and the deployment's rule lets unverified people in (the session lookup's rule).
 */
export async function userMayAct(
  prisma: Pick<PrismaClient, "user" | "deploymentSettings">,
  userId: string,
  rule: UserGateRule,
): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { status: true, emailVerified: true },
  });
  if (user?.status !== "active") return false;
  if (user.emailVerified) return true;
  if (rule.hasEmailDelivery) return false;
  if (rule.devFlagAllowed) return true;
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { signupMode: true, signupPolicyInitialized: true },
  });
  return unverifiedAccessAllowed({
    hasEmailDelivery: false,
    devFlagAllowed: false,
    mode: settings?.signupPolicyInitialized ? settings.signupMode : undefined,
  });
}
