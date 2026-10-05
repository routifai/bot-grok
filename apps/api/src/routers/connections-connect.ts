import { pickReusableConnection, sanitizeComposioError } from "@aiden/adapters";
import { IsolationError } from "@aiden/db";
import { getLogger } from "@aiden/logging";
import { ORPCError } from "@orpc/server";
import { concreteKeepAccountIds, lockProviderConnectionScope } from "./connections-support.js";
import type { RouterContext } from "./context.js";
import { connectionContext } from "./shared.js";

export function connectProcedures(c: RouterContext) {
  const { deps, authed } = c;
  return {
    begin: authed.connections.begin.handler(async ({ context, input }) => {
      const connector =
        deps.integrationSettings &&
        (input.connectorId === "composio" || input.connectorId === "pipedream")
          ? await deps.integrationSettings.resolve(input.connectorId)
          : deps.connectors.managed(input.connectorId);
      if (!connector) {
        throw new ORPCError("BAD_REQUEST", {
          message: `Connector ${input.connectorId} is not configured`,
        });
      }
      // Share the revoke scope lock so a slug-wide remote delete cannot miss a
      // row that is inserted after SELECT FOR UPDATE and before remote revoke.
      const row = await deps.prisma.$transaction(async (tx) => {
        await lockProviderConnectionScope(tx, context.actor, input.connectorId, input.provider);
        const existing = await tx.connection.findMany({
          where: {
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            connectorId: input.connectorId,
            provider: input.provider,
          },
          select: { id: true, status: true },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        });
        const reusable = pickReusableConnection(existing);
        if (reusable) {
          return tx.connection.update({
            where: { id: reusable.id },
            data: {
              displayName: input.displayName,
              status: "pending",
              providerRef: null,
              metadata: {},
            },
          });
        }
        return tx.connection.create({
          data: {
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            connectorId: input.connectorId,
            provider: input.provider,
            displayName: input.displayName,
            status: "pending",
          },
        });
      });
      try {
        const auth = await connector.begin(
          { provider: input.provider, redirectUrl: `${deps.env.webOrigin}/app` },
          connectionContext(context.actor, "connections.begin", context.signal),
        );
        // Re-take the provider lock and only advance still-pending rows so a
        // concurrent revoke cannot be overwritten back to pending/connected.
        const applied = await deps.prisma.$transaction(async (tx) => {
          await lockProviderConnectionScope(tx, context.actor, input.connectorId, input.provider);
          const updated = await tx.connection.updateMany({
            where: {
              id: row.id,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              status: "pending",
            },
            data: {
              status: auth.authorizationUrl ? "pending" : "connected",
              providerRef: auth.state || null,
              metadata: { state: auth.state },
            },
          });
          return updated.count > 0;
        });
        if (!applied) {
          // Revoke won the race. Clean up without a provider-wide slug delete.
          const state = auth.state?.trim();
          const adapterContext = connectionContext(
            context.actor,
            "connections.begin",
            context.signal,
          );
          if (state && state !== input.provider) {
            // Composio browser OAuth stores an authorization-request id in
            // auth.state. Prefer canceling that pending request by id so the
            // authorization URL cannot later create an untracked remote. The
            // request id is the connected-account nanoid (INITIATED until OAuth
            // finishes). Fall back to resolving an ACTIVE account id only when
            // cancel is unavailable.
            const cancelAuthorizationRequest = (
              connector as {
                cancelAuthorizationRequest?: (
                  requestId: string,
                  context: typeof adapterContext,
                ) => Promise<void>;
              }
            ).cancelAuthorizationRequest;
            if (cancelAuthorizationRequest) {
              await cancelAuthorizationRequest(state, adapterContext).catch(() => undefined);
            } else {
              const resolveAccountId = (
                connector as {
                  resolveConnectedAccountId?: (
                    userId: string,
                    slug: string,
                    currentRef: string | null | undefined,
                    excludeIds?: string[],
                    spaceId?: string,
                  ) => Promise<string | undefined>;
                }
              ).resolveConnectedAccountId;
              let revokeRef = state;
              if (resolveAccountId) {
                const resolved = await resolveAccountId(
                  context.actor.userId,
                  input.provider,
                  state,
                  [],
                  context.actor.spaceId,
                ).catch(() => undefined);
                if (!resolved) {
                  revokeRef = "";
                } else {
                  revokeRef = resolved;
                }
              }
              if (revokeRef) {
                await connector.revoke(revokeRef, adapterContext).catch(() => undefined);
              }
            }
          } else if (state === input.provider) {
            // Pipedream begin only returns the app slug. Drop remotes that no
            // remaining local row still references so a lost race cannot leave
            // an orphan authorization, without wiping sibling accounts.
            const revokeUnreferenced = (
              connector as {
                revokeUnreferencedAccounts?: (
                  slug: string,
                  keepAccountIds: string[],
                  context: ReturnType<typeof connectionContext>,
                ) => Promise<void>;
              }
            ).revokeUnreferencedAccounts;
            if (revokeUnreferenced) {
              // Hold the provider lock across the keep-id snapshot and remote
              // cleanup so a concurrent complete cannot persist a providerRef
              // that this cleanup then deletes as unreferenced.
              await deps.prisma
                .$transaction(
                  async (tx) => {
                    await lockProviderConnectionScope(
                      tx,
                      context.actor,
                      input.connectorId,
                      input.provider,
                    );
                    const kept = await tx.connection.findMany({
                      where: {
                        spaceId: context.actor.spaceId,
                        userId: context.actor.userId,
                        connectorId: input.connectorId,
                        provider: input.provider,
                        status: { in: ["connected", "pending", "error"] },
                      },
                      select: { providerRef: true },
                    });
                    const { keepIds, canRevokeUnreferenced } = concreteKeepAccountIds(
                      kept.map((entry) => entry.providerRef),
                      input.provider,
                    );
                    // Skip while any sibling still lacks a concrete account id —
                    // otherwise slug-only pending refs are dropped from keepIds and
                    // revokeUnreferencedAccounts deletes that sibling's remote auth.
                    if (!canRevokeUnreferenced) return;
                    await revokeUnreferenced(input.provider, keepIds, adapterContext);
                  },
                  { timeout: 60_000 },
                )
                .catch(() => undefined);
            }
          }
          throw new IsolationError();
        }
        return { connectionId: row.id, authorizationUrl: auth.authorizationUrl };
      } catch (error) {
        if (error instanceof IsolationError) throw error;
        await deps.prisma.connection.updateMany({
          where: {
            id: row.id,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            status: "pending",
          },
          data: { status: "error" },
        });
        throw new ORPCError("BAD_REQUEST", { message: sanitizeComposioError(error) });
      }
    }),
    complete: authed.connections.complete.handler(async ({ context, input }) => {
      const existing = await deps.prisma.connection.findFirst({
        where: {
          id: input.connectionId,
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
        },
      });
      if (!existing) throw new IsolationError();
      const connector = deps.connectors.managed(existing.connectorId);
      if (!connector) {
        throw new ORPCError("BAD_REQUEST", {
          message: `Connector ${existing.connectorId} is not configured`,
        });
      }
      let row = existing;
      if (existing.status !== "connected") {
        // Hold the provider lock across remote completion, account-id resolution,
        // providerRef persistence, and any overlapping revokeUnreferenced cleanup
        // so a concurrent begin-loss cleanup cannot delete the account we are about
        // to persist.
        row = await deps.prisma.$transaction(
          async (tx) => {
            await lockProviderConnectionScope(
              tx,
              context.actor,
              existing.connectorId,
              existing.provider,
            );
            const current = await tx.connection.findFirst({
              where: {
                id: existing.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
            });
            if (!current) throw new IsolationError();
            if (current.status === "connected") return current;
            if (current.status === "revoked") {
              // Authorization URLs from a revoke-win begin can still finish
              // remotely. Cancel leftover Composio request ids / drop Pipedream
              // remotes no active local row still references before rejecting.
              const revokedContext = connectionContext(
                context.actor,
                "connections.complete",
                context.signal,
              );
              const restoreRevokedForRetry = async () => {
                // Cleanup failed while the row is already revoked — restore pending
                // so the UI can retry removal instead of leaving an orphan remote.
                // Use the root client (not tx): throwing IsolationError aborts this
                // transaction and would otherwise roll back a tx-scoped restore.
                await deps.prisma.connection.updateMany({
                  where: {
                    id: current.id,
                    spaceId: context.actor.spaceId,
                    userId: context.actor.userId,
                    status: "revoked",
                  },
                  data: { status: "pending" },
                });
              };
              const pendingRef = current.providerRef?.trim();
              try {
                if (pendingRef && pendingRef !== current.provider) {
                  const cancelAuthorizationRequest = (
                    connector as {
                      cancelAuthorizationRequest?: (
                        requestId: string,
                        context: typeof revokedContext,
                      ) => Promise<void>;
                    }
                  ).cancelAuthorizationRequest;
                  if (cancelAuthorizationRequest) {
                    await cancelAuthorizationRequest(pendingRef, revokedContext);
                  } else {
                    const resolveAccountId = (
                      connector as {
                        resolveConnectedAccountId?: (
                          userId: string,
                          slug: string,
                          currentRef: string | null | undefined,
                          excludeIds?: string[],
                          spaceId?: string,
                        ) => Promise<string | undefined>;
                      }
                    ).resolveConnectedAccountId;
                    let revokeRef = pendingRef;
                    if (resolveAccountId) {
                      const resolved = await resolveAccountId(
                        context.actor.userId,
                        current.provider,
                        pendingRef,
                        [],
                        context.actor.spaceId,
                      ).catch(() => undefined);
                      revokeRef = resolved ?? "";
                    }
                    if (revokeRef) {
                      await connector.revoke(revokeRef, revokedContext);
                    }
                  }
                } else {
                  const revokeUnreferenced = (
                    connector as {
                      revokeUnreferencedAccounts?: (
                        slug: string,
                        keepAccountIds: string[],
                        context: typeof revokedContext,
                      ) => Promise<void>;
                    }
                  ).revokeUnreferencedAccounts;
                  if (revokeUnreferenced) {
                    const kept = await tx.connection.findMany({
                      where: {
                        spaceId: context.actor.spaceId,
                        userId: context.actor.userId,
                        connectorId: existing.connectorId,
                        provider: existing.provider,
                        status: { in: ["connected", "pending", "error"] },
                      },
                      select: { providerRef: true },
                    });
                    const { keepIds, canRevokeUnreferenced } = concreteKeepAccountIds(
                      kept.map((entry) => entry.providerRef),
                      existing.provider,
                    );
                    if (canRevokeUnreferenced) {
                      await revokeUnreferenced(existing.provider, keepIds, revokedContext);
                    }
                  }
                }
              } catch (error) {
                getLogger().error(
                  "connections.complete remote cleanup failed for revoked row",
                  error,
                  {
                    connectionId: current.id,
                    connectorId: existing.connectorId,
                    provider: existing.provider,
                  },
                );
                await restoreRevokedForRetry();
              }
              throw new IsolationError();
            }

            const adapterContext = connectionContext(
              context.actor,
              "connections.complete",
              context.signal,
            );
            if (input.code) {
              const state = current.providerRef ?? current.provider;
              try {
                await connector.complete({ state, code: input.code }, adapterContext);
              } catch (error) {
                throw new ORPCError("BAD_REQUEST", { message: sanitizeComposioError(error) });
              }
            }
            const ready = await connector.connectionReady(adapterContext, current.provider);
            if (!ready) return current;

            // Browser OAuth stores a connection-request id in providerRef from
            // begin. Resolve it to the connected-account id so revoke deletes the
            // right remote authorization. Prefer an account id not already used
            // by a sibling row for the same provider.
            const resolveAccountId = (
              connector as {
                resolveConnectedAccountId?: (
                  userId: string,
                  slug: string,
                  currentRef: string | null | undefined,
                  excludeIds?: string[],
                  spaceId?: string,
                ) => Promise<string | undefined>;
                connectedAccountId?: (userId: string, slug: string) => Promise<string | undefined>;
              }
            ).resolveConnectedAccountId;
            const fallbackAccountId = (
              connector as {
                connectedAccountId?: (userId: string, slug: string) => Promise<string | undefined>;
              }
            ).connectedAccountId;
            let resolvedAccountId: string | undefined;
            if (resolveAccountId || fallbackAccountId) {
              const siblings = await tx.connection.findMany({
                where: {
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                  connectorId: existing.connectorId,
                  provider: existing.provider,
                  id: { not: existing.id },
                  status: { in: ["connected", "pending", "error"] },
                },
                select: { providerRef: true },
              });
              // Exclude concrete account ids only. A pending sibling may still
              // store a slug or authorization-request id; passing those raw refs
              // would not match remote account ids and can let this row adopt the
              // sibling's account. If a sibling ref cannot be resolved yet, leave
              // this row pending so a later complete can re-resolve safely.
              const excludeIds: string[] = [];
              let unresolvedSibling = false;
              for (const sibling of siblings) {
                const ref = sibling.providerRef?.trim();
                // Slug-only refs cannot identify a concrete remote account; resolving
                // them would pick an arbitrary ACTIVE id and over-exclude.
                if (!ref || ref === existing.provider) continue;
                if (resolveAccountId) {
                  const resolvedSiblingId = await resolveAccountId(
                    context.actor.userId,
                    existing.provider,
                    ref,
                    [],
                    context.actor.spaceId,
                  ).catch(() => undefined);
                  if (resolvedSiblingId) {
                    excludeIds.push(resolvedSiblingId);
                  } else {
                    unresolvedSibling = true;
                  }
                } else {
                  excludeIds.push(ref);
                }
              }
              if (unresolvedSibling) {
                return current;
              }
              resolvedAccountId = resolveAccountId
                ? await resolveAccountId(
                    context.actor.userId,
                    existing.provider,
                    current.providerRef,
                    excludeIds,
                    context.actor.spaceId,
                  ).catch(() => undefined)
                : await fallbackAccountId!(context.actor.userId, existing.provider).catch(
                    () => undefined,
                  );
            }

            // When a resolver exists and providerRef is still a request-scoped
            // id (not the provider slug), require a concrete account id before
            // marking connected — otherwise revoke would delete the wrong ref.
            if (
              resolveAccountId &&
              current.providerRef &&
              current.providerRef !== current.provider &&
              !resolvedAccountId
            ) {
              return current;
            }

            const providerRef = resolvedAccountId ?? current.providerRef;
            if (providerRef) {
              const taken = await tx.connection.findFirst({
                where: {
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                  connectorId: existing.connectorId,
                  provider: existing.provider,
                  id: { not: existing.id },
                  status: { in: ["connected", "pending", "error"] },
                  providerRef,
                },
                select: { id: true },
              });
              if (taken) {
                // Do not mark connected with a request-scoped or shared ref —
                // leave pending so a later complete can re-resolve an unused id.
                return current;
              }
            }
            return tx.connection.update({
              where: { id: current.id },
              data: {
                status: "connected",
                ...(providerRef ? { providerRef } : {}),
              },
            });
          },
          { timeout: 60_000 },
        );
      }
      return {
        id: row.id,
        connectorId: row.connectorId,
        provider: row.provider,
        displayName: row.displayName,
        status: row.status as "pending" | "connected" | "revoked" | "error",
        capabilities: [],
        createdAt: row.createdAt.toISOString(),
      };
    }),
  };
}
