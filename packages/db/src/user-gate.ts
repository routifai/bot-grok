import { unverifiedAccessAllowed } from "@nova/core";
import type { PrismaClient } from "./client.js";

/**
 * Whether mail can be sent and the signup mode are read from DeploymentSettings (the API records
 * its delivery state at boot), so every process, the worker included, applies one rule.
 */
export interface UserGateRule {
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
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { signupMode: true, signupPolicyInitialized: true, emailDelivery: true },
  });
  return unverifiedAccessAllowed({
    hasEmailDelivery: settings?.emailDelivery ?? false,
    devFlagAllowed: rule.devFlagAllowed,
    mode: settings?.signupPolicyInitialized ? settings.signupMode : undefined,
  });
}
