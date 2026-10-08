import type { ConnectorCatalogItem } from "@nova/adapter-kit";
import { sanitizeComposioError } from "@nova/adapters";
import { IsolationError } from "@nova/db";
import { getLogger } from "@nova/logging";
import { ORPCError } from "@orpc/server";
import { connectProcedures } from "./connections-connect.js";
import {
  lockProviderConnectionScope,
  reconcilePendingConnections,
  shouldRestoreLocalAfterRemoteRevokeFailure,
} from "./connections-support.js";
import type { RouterContext } from "./context.js";
import { connectionContext } from "./shared.js";

export function connectionsRouter(c: RouterContext) {
  const { deps, authed } = c;
  return {
    connections: {
      catalog: authed.connections.catalog.handler(async ({ context, input }) => {
        const adapterContext = connectionContext(
          context.actor,
          "connections.catalog",
          context.signal,
        );
        const providers = input.connectorId
          ? [deps.connectors.managed(input.connectorId)].filter(
              (provider): provider is NonNullable<typeof provider> => Boolean(provider),
            )
          : deps.connectors.managedProviders();
        const catalogs = await Promise.all(
          providers.map(async (provider): Promise<ConnectorCatalogItem[]> => {
            try {
              const items = await provider.catalog(adapterContext, input.query);
              const nowConnected = items.filter((item) => item.connected).map((item) => item.slug);
              if (nowConnected.length > 0) {
                await reconcilePendingConnections(
                  deps.prisma,
                  context.actor,
                  provider.describe().id,
                  nowConnected,
                ).catch((error) => {
                  getLogger().error(
                    `${provider.describe().id} pending-connection reconciliation failed`,
                    error,
                  );
                });
              }
              return items;
            } catch {
              return [];
            }
          }),
        );
        return catalogs.flat();
      }),
      list: authed.connections.list.handler(async ({ context }) => {
        const rows = await deps.prisma.connection.findMany({
          where: { spaceId: context.actor.spaceId, userId: context.actor.userId },
        });
        return rows.map((row) => ({
          id: row.id,
          connectorId: row.connectorId,
          provider: row.provider,
          displayName: row.displayName,
          status: row.status as "pending" | "connected" | "revoked" | "error",
          capabilities: [],
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      rename: authed.connections.rename.handler(async ({ context, input }) => {
        const existing = await deps.prisma.connection.findFirst({
          where: {
            id: input.connectionId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (!existing) throw new IsolationError();
        const row = await deps.prisma.connection.update({
          where: { id: existing.id },
          data: { displayName: input.displayName },
        });
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
      revoke: authed.connections.revoke.handler(async ({ context, input }) => {
        type RemoteRevoke = {
          connectorId: string;
          connectionRef: string;
          accountSpecific: boolean;
        };
        const outcome = await deps.prisma.$transaction(
          async (tx) => {
            const row = await tx.connection.findFirst({
              where: {
                id: input.connectionId,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
            });
            if (!row) {
              return {
                remote: null as null | RemoteRevoke,
                previousStatus: null as string | null,
              };
            }

            // Advisory lock covers inserts as well as existing rows. SELECT FOR UPDATE
            // alone misses a concurrent begin that inserts after the lock query.
            await lockProviderConnectionScope(tx, context.actor, row.connectorId, row.provider);
            await tx.$queryRaw`
              SELECT id
              FROM connections
              WHERE "spaceId" = ${context.actor.spaceId}
                AND "userId" = ${context.actor.userId}
                AND "connectorId" = ${row.connectorId}
                AND provider = ${row.provider}
                AND status IN ('connected', 'pending', 'error')
              FOR UPDATE`;

            const updated = await tx.connection.updateMany({
              where: {
                id: row.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                status: { in: ["connected", "pending", "error"] },
              },
              data: { status: "revoked" },
            });
            if (updated.count === 0) {
              return {
                remote: null as null | RemoteRevoke,
                previousStatus: null as string | null,
              };
            }

            const remaining = await tx.connection.count({
              where: {
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                connectorId: row.connectorId,
                provider: row.provider,
                status: { in: ["connected", "pending"] },
              },
            });
            const connectionRef = row.providerRef || row.provider;
            const accountSpecific = Boolean(row.providerRef && row.providerRef !== row.provider);
            // Account-scoped refs can disconnect one remote authorization while
            // siblings remain. Slug-only legacy rows must wait until they are last,
            // or a provider-wide revoke would drop every account for that app.
            if (!accountSpecific && remaining > 0) {
              return {
                remote: null as null | RemoteRevoke,
                previousStatus: null as string | null,
              };
            }

            // Slug-only remote delete is provider-wide. Run it before commit while
            // still holding the begin/revoke lock so a new authorization cannot be
            // created and then wiped by Pipedream's slug-scoped DELETE.
            if (!accountSpecific) {
              const connector = deps.connectors.managed(row.connectorId);
              if (!connector) {
                throw new ORPCError("BAD_REQUEST", {
                  message: `Connector ${row.connectorId} is not configured`,
                });
              }
              try {
                // Abort before the 60s Prisma transaction timeout so a late remote
                // delete cannot succeed after local status has already rolled back.
                const signals = [AbortSignal.timeout(45_000)];
                if (context.signal) signals.unshift(context.signal);
                const revokeSignal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
                await connector.revoke(
                  connectionRef,
                  connectionContext(context.actor, "connections.revoke", revokeSignal),
                );
              } catch (error) {
                if (error instanceof ORPCError) throw error;
                throw new ORPCError("BAD_REQUEST", { message: sanitizeComposioError(error) });
              }
              return {
                remote: null as null | RemoteRevoke,
                previousStatus: null as string | null,
              };
            }

            return {
              remote: {
                connectorId: row.connectorId,
                connectionRef,
                accountSpecific,
              },
              previousStatus: row.status,
            };
          },
          { timeout: 60_000 },
        );

        if (outcome.remote) {
          const restoreLocalStatus = async () => {
            // Local row was marked revoked inside the transaction; restore it so a
            // failed remote disconnect remains retryable instead of orphaned.
            if (!outcome.previousStatus) return;
            await deps.prisma.connection.updateMany({
              where: {
                id: input.connectionId,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                status: "revoked",
              },
              data: { status: outcome.previousStatus },
            });
          };
          try {
            const connector = deps.connectors.managed(outcome.remote.connectorId);
            if (!connector) {
              throw new ORPCError("BAD_REQUEST", {
                message: `Connector ${outcome.remote.connectorId} is not configured`,
              });
            }
            await connector.revoke(
              outcome.remote.connectionRef,
              connectionContext(context.actor, "connections.revoke", context.signal),
            );
          } catch (error) {
            // Restore when DELETE clearly did not run (including pre-delete list
            // timeouts). Post-delete timeouts stay ambiguous — leave revoked.
            if (shouldRestoreLocalAfterRemoteRevokeFailure(error)) {
              await restoreLocalStatus();
            } else {
              getLogger().error(
                "connections.revoke remote outcome uncertain; leaving local revoked",
                error,
                {
                  connectionId: input.connectionId,
                  connectorId: outcome.remote.connectorId,
                },
              );
            }
            if (error instanceof ORPCError) throw error;
            throw new ORPCError("BAD_REQUEST", { message: sanitizeComposioError(error) });
          }
        }
        return { ok: true as const };
      }),
      tools: authed.connections.tools.handler(async ({ context, input }) => {
        const connector = deps.connectors.managed(input.connectorId);
        if (!connector) return [];
        const row = await deps.prisma.connection.findFirst({
          where: {
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            connectorId: input.connectorId,
            provider: input.provider,
            status: "connected",
          },
        });
        if (!row) return [];
        try {
          const tools = await connector.discoverTools({
            ...connectionContext(context.actor, "connections.tools", context.signal),
            connectedConnections: [
              {
                id: row.id,
                connectorId: input.connectorId,
                externalId: input.provider,
                displayName: row.displayName,
                providerRef: row.providerRef ?? undefined,
              },
            ],
            connectedProviders: [input.provider],
          });
          return tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
          }));
        } catch (error) {
          getLogger().error("connections.tools failed", error, {
            connectorId: input.connectorId,
            provider: input.provider,
          });
          return [];
        }
      }),
      ...connectProcedures(c),
    },
  };
}
