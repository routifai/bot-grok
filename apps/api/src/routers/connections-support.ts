import { planLiveConnectionSync } from "@nova/adapters";
import type { Actor } from "@nova/contracts";
import type { Prisma, PrismaClient } from "@nova/db";

export async function reconcilePendingConnections(
  prisma: PrismaClient,
  owner: Pick<Actor, "spaceId" | "userId">,
  connectorId: string,
  connectedProviders: string[],
): Promise<void> {
  const connectedProviderKeys = new Set(
    connectedProviders.map((provider) => provider.trim().toLowerCase()),
  );
  const rows = (
    await prisma.connection.findMany({
      where: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        connectorId,
        status: { in: ["pending", "connected"] },
      },
      select: { id: true, provider: true, displayName: true, status: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
  ).filter((row: { provider: string }) =>
    connectedProviderKeys.has(row.provider.trim().toLowerCase()),
  );
  const sync = planLiveConnectionSync(rows, connectedProviders);
  const updates = [
    ...(sync.connectIds.length > 0
      ? [
          prisma.connection.updateMany({
            where: {
              id: { in: sync.connectIds },
              spaceId: owner.spaceId,
              userId: owner.userId,
              status: "pending",
            },
            data: { status: "connected" },
          }),
        ]
      : []),
    ...(sync.revokeIds.length > 0
      ? [
          prisma.connection.updateMany({
            where: {
              id: { in: sync.revokeIds },
              spaceId: owner.spaceId,
              userId: owner.userId,
              status: "pending",
            },
            data: { status: "revoked" },
          }),
        ]
      : []),
  ];
  if (updates.length > 0) await prisma.$transaction(updates);
}

/** Serialize begin/revoke for one user+provider so slug-wide remote deletes cannot race a new connect. */

export function isAmbiguousRemoteRevokeFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error && typeof error.name === "string" ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|aborted|network|ECONNRESET|ECONNREFUSED|fetch failed/i.test(message);
}

/** True when a connector failed before issuing any remote DELETE. */
export function isRemoteRevokePreDeleteFailure(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "remoteRevokePreDelete" in error &&
      (error as { remoteRevokePreDelete?: boolean }).remoteRevokePreDelete === true,
  );
}

export function shouldRestoreLocalAfterRemoteRevokeFailure(error: unknown): boolean {
  // Pre-delete list/network failures never reached DELETE — always keep retry state.
  // Post-delete timeouts stay ambiguous and leave the row revoked.
  return isRemoteRevokePreDeleteFailure(error) || !isAmbiguousRemoteRevokeFailure(error);
}

/**
 * Concrete account ids still referenced by active local rows. When any row still
 * only has the provider slug (or no ref), orphan cleanup must not run — a sibling
 * may have created its remote account before persisting the concrete id.
 */
export function concreteKeepAccountIds(
  refs: Array<string | null | undefined>,
  provider: string,
): { keepIds: string[]; canRevokeUnreferenced: boolean } {
  const keepIds: string[] = [];
  let canRevokeUnreferenced = true;
  for (const ref of refs) {
    const value = ref?.trim();
    if (!value || value === provider) {
      canRevokeUnreferenced = false;
      continue;
    }
    keepIds.push(value);
  }
  return { keepIds, canRevokeUnreferenced };
}

export async function lockProviderConnectionScope(
  tx: Prisma.TransactionClient,
  owner: Pick<Actor, "spaceId" | "userId">,
  connectorId: string,
  provider: string,
): Promise<void> {
  // Avoid NUL separators in the lock key; text params may truncate at a zero byte and break begin.
  const scope = `space:${owner.spaceId}|user:${owner.userId}|connector:${connectorId}|provider:${provider}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('connection-provider'), hashtext(${scope}))`;
}
