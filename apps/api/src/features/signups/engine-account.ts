// The engine side of an account the signup flow pauses (quarantine) or resets (a clean approval
// after one). Scheduled tasks and in-flight runs live in the engine, which only lets an engine
// admin pause or remove an account, so these calls go as the deployment owner.

import {
  deleteOmnigentUser,
  type OmnigentClientConfig,
  setOmnigentUserSuspended,
} from "@superchat/adapters";
import { type EngineModelsDeps, onModels } from "../models/index.js";

type EngineOutcome = "done" | "no-engine" | "no-owner";

async function engineAdminEmail(deps: EngineModelsDeps): Promise<string | null> {
  const settings = await deps.prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { ownerUserId: true },
  });
  if (!settings?.ownerUserId) return null;
  const owner = await deps.prisma.user.findUnique({
    where: { id: settings.ownerUserId },
    select: { email: true },
  });
  return owner?.email ?? null;
}

/**
 * Stop (or resume) an account's engine-side work. The deployment owner must also be an engine
 * admin; an engine refusal throws, and "no engine" or "no owner" is reported so the caller can
 * warn. Engine users are named by email.
 */
export async function setEngineAccountSuspended(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  email: string,
  suspended: boolean,
): Promise<EngineOutcome> {
  if (!client) return "no-engine";
  const admin = await engineAdminEmail(deps);
  if (!admin) return "no-owner";
  await onModels(setOmnigentUserSuspended(client, admin, email, suspended));
  return "done";
}

/**
 * Reset an engine account instead of resuming it. The engine's user delete removes the person's
 * sessions, managed Computers, keys, scheduled tasks and account, and forgets their long-term
 * memory; the account is recreated, empty, on next use. This is what a clean approval after a
 * quarantine needs: a squatter's memory and schedules must not come back with the same email.
 */
export async function resetEngineAccount(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  email: string,
): Promise<EngineOutcome> {
  if (!client) return "no-engine";
  const admin = await engineAdminEmail(deps);
  if (!admin) return "no-owner";
  await onModels(deleteOmnigentUser(client, admin, email));
  return "done";
}
