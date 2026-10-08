import { assertSafeRemoteUrl, buildMcpCredentialBlob } from "@nova/adapters";
import type { Actor, McpServer } from "@nova/contracts";
import { IsolationError, type Prisma } from "@nova/db";
import { ORPCError } from "@orpc/server";
import { buildMcpUpdateMaterial } from "../mcp-material.js";
import type { RouterContext, RouterDeps } from "./context.js";
import { computerContext } from "./shared.js";

function mcpServerDto(
  row: {
    id: string;
    spaceId: string;
    slug: string;
    name: string;
    description: string;
    transport: string;
    endpoint: string | null;
    command: string | null;
    args: unknown;
    env: unknown;
    headers: unknown;
    secretId: string | null;
    enabled: boolean;
    revision: number;
    createdAt: Date;
    updatedAt: Date;
  },
  oauthStatus: McpServer["oauthStatus"] = "none",
): McpServer {
  const args = Array.isArray(row.args)
    ? row.args.filter((item): item is string => typeof item === "string")
    : [];
  const envKeys =
    row.env && typeof row.env === "object" && !Array.isArray(row.env) ? Object.keys(row.env) : [];
  const headerKeys =
    row.headers && typeof row.headers === "object" && !Array.isArray(row.headers)
      ? Object.keys(row.headers)
      : [];
  return {
    id: row.id,
    spaceId: row.spaceId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    transport: row.transport as McpServer["transport"],
    endpoint: row.endpoint,
    command: row.command,
    args,
    envKeys,
    headerKeys,
    hasSecret: row.secretId !== null,
    oauthStatus,
    enabled: row.enabled,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function assertMcpRemoteEndpoint(
  endpoint: string | null | undefined,
  actor: Actor,
  deps: Pick<RouterDeps, "remoteConnectors" | "env">,
): Promise<void> {
  if (!endpoint) return;
  try {
    await assertSafeRemoteUrl(endpoint, deps.remoteConnectors?.resolveHostname, {
      allowPrivateEndpoint: actor.isDeploymentOwner || deps.env.mcpAllowPrivateEndpoint === true,
    });
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "MCP endpoint is invalid",
    });
  }
}

function mcpAssignmentDto(row: {
  id: string;
  botId: string;
  serverId: string;
  allowAllTools: boolean;
  allowedTools: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    botId: row.botId,
    serverId: row.serverId,
    allowAllTools: row.allowAllTools,
    allowedTools: Array.isArray(row.allowedTools)
      ? row.allowedTools.filter((item): item is string => typeof item === "string")
      : [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function mcpRouter(c: RouterContext) {
  const { authed, mcpOAuth, deps } = c;
  return {
    mcp: {
      servers: {
        list: authed.mcp.servers.list.handler(async ({ context }) => {
          const rows = await deps.prisma.mcpServer.findMany({
            where: { spaceId: context.actor.spaceId, userId: context.actor.userId },
            orderBy: [{ name: "asc" }, { createdAt: "asc" }],
          });
          const secretIds = rows.flatMap((row) => (row.secretId ? [row.secretId] : []));
          const secrets = secretIds.length
            ? await deps.prisma.secret.findMany({
                where: {
                  id: { in: secretIds },
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                },
                select: { id: true, ciphertext: true },
              })
            : [];
          const ciphertextById = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
          return rows.map((row) =>
            mcpServerDto(
              row,
              mcpOAuth.statusForCiphertext(
                row.secretId ? ciphertextById.get(row.secretId) : undefined,
                row.secretId ?? undefined,
              ),
            ),
          );
        }),
        create: authed.mcp.servers.create.handler(async ({ context, input }) => {
          await assertMcpRemoteEndpoint(
            "endpoint" in input ? input.endpoint : null,
            context.actor,
            deps,
          );
          const secretPayload = buildMcpCredentialBlob(input);
          const stored = secretPayload
            ? await deps.secrets.put(
                secretPayload,
                computerContext(context.actor, "mcp", "mcp.create"),
              )
            : null;
          const row = await deps.prisma.$transaction(async (tx) => {
            if (stored) {
              await tx.secret.create({
                data: {
                  id: stored.id,
                  userId: context.actor.userId,
                  spaceId: context.actor.spaceId,
                  kind: "mcp",
                  ciphertext: stored.ciphertext,
                },
              });
            }
            return tx.mcpServer.create({
              data: {
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                slug: input.slug,
                name: input.name,
                description: input.description,
                transport: input.transport,
                endpoint: "endpoint" in input ? input.endpoint : null,
                command: "command" in input ? input.command : null,
                args: ("args" in input ? input.args : []) as Prisma.InputJsonValue,
                env: ("env" in input
                  ? Object.fromEntries(Object.keys(input.env).map((key) => [key, true]))
                  : {}) as Prisma.InputJsonValue,
                headers: ("headers" in input
                  ? Object.fromEntries(Object.keys(input.headers).map((key) => [key, true]))
                  : {}) as Prisma.InputJsonValue,
                secretId: stored?.id,
                enabled: input.enabled,
              },
            });
          });
          return mcpServerDto(row, await mcpOAuth.statusFor(row, context.actor));
        }),
        update: authed.mcp.servers.update.handler(async ({ context, input }) => {
          const row = await deps.prisma.$transaction(async (tx) => {
            // Share the OAuth broker's per-server lock so a stale authorization
            // snapshot cannot overwrite a simultaneous credential edit.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mcp-oauth-material'), hashtext(${input.id}))`;
            const existing = await tx.mcpServer.findFirst({
              where: {
                id: input.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
            });
            if (!existing) throw new IsolationError();
            const existingSecret = existing.secretId
              ? await tx.secret.findFirst({
                  where: {
                    id: existing.secretId,
                    spaceId: context.actor.spaceId,
                    userId: context.actor.userId,
                  },
                })
              : null;
            let existingMaterial: Record<string, unknown> = {};
            if (existingSecret) {
              try {
                const value = JSON.parse(
                  deps.secrets.load(existingSecret.ciphertext, existingSecret.id),
                );
                if (value && typeof value === "object" && !Array.isArray(value))
                  existingMaterial = value as Record<string, unknown>;
              } catch {
                /* Existing malformed secrets are replaced only when new credentials are supplied. */
              }
            }
            const config =
              "config" in input
                ? input.config
                : {
                    slug: existing.slug,
                    name: existing.name,
                    description: existing.description,
                    enabled: existing.enabled,
                    transport: existing.transport as "streamable_http" | "sse",
                    endpoint: existing.endpoint!,
                    headers: (existingMaterial.headers ?? {}) as Record<string, string>,
                    secret: input.secret,
                  };
            if (!("config" in input) && existing.transport === "stdio") {
              throw new ORPCError("BAD_REQUEST", { message: "A remote MCP server is required" });
            }
            const nextEndpoint = "endpoint" in config ? config.endpoint : null;
            if (existing.endpoint !== nextEndpoint) {
              await assertMcpRemoteEndpoint(nextEndpoint, context.actor, deps);
            }
            const update = buildMcpUpdateMaterial(existingMaterial, config, {
              clearOAuth: existing.endpoint !== nextEndpoint,
            });
            const stored =
              update.action === "store" && Object.keys(update.material).length > 0
                ? await deps.secrets.put(
                    JSON.stringify(update.material),
                    computerContext(context.actor, "mcp", "mcp.update"),
                  )
                : null;
            const clearing = update.action === "store" && Object.keys(update.material).length === 0;
            if (stored) {
              await tx.secret.create({
                data: {
                  id: stored.id,
                  userId: context.actor.userId,
                  spaceId: context.actor.spaceId,
                  kind: "mcp",
                  ciphertext: stored.ciphertext,
                },
              });
            }
            const updated = await tx.mcpServer.update({
              where: { id: existing.id },
              data: {
                slug: config.slug,
                name: config.name,
                description: config.description,
                transport: config.transport,
                endpoint: nextEndpoint,
                command: "command" in config ? config.command : null,
                args: ("args" in config ? config.args : []) as Prisma.InputJsonValue,
                env: ("env" in config
                  ? Object.fromEntries(Object.keys(config.env).map((key) => [key, true]))
                  : {}) as Prisma.InputJsonValue,
                headers: ("headers" in config
                  ? Object.fromEntries(Object.keys(config.headers).map((key) => [key, true]))
                  : {}) as Prisma.InputJsonValue,
                enabled: config.enabled,
                revision: { increment: 1 },
                ...(stored ? { secretId: stored.id } : clearing ? { secretId: null } : {}),
              },
            });
            if (stored) {
              if (existing.secretId)
                await tx.secret.deleteMany({
                  where: {
                    id: existing.secretId,
                    spaceId: context.actor.spaceId,
                    userId: context.actor.userId,
                  },
                });
            } else if (clearing && existing.secretId) {
              await tx.secret.deleteMany({
                where: {
                  id: existing.secretId,
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                },
              });
            }
            return updated;
          });
          return mcpServerDto(row, await mcpOAuth.statusFor(row, context.actor));
        }),
        remove: authed.mcp.servers.remove.handler(async ({ context, input }) => {
          const server = await deps.prisma.mcpServer.findFirst({
            where: {
              id: input.id,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
            select: { id: true, secretId: true },
          });
          if (!server) throw new IsolationError();
          // Assignments cascade; the encrypted credential must go with the server.
          await deps.prisma.$transaction([
            deps.prisma.mcpServer.delete({ where: { id: server.id } }),
            ...(server.secretId
              ? [
                  deps.prisma.secret.deleteMany({
                    where: {
                      id: server.secretId,
                      spaceId: context.actor.spaceId,
                      userId: context.actor.userId,
                    },
                  }),
                ]
              : []),
          ]);
          return { ok: true as const };
        }),
      },
      assignments: {
        all: authed.mcp.assignments.all.handler(async ({ context }) => {
          const rows = await deps.prisma.botMcpServer.findMany({
            where: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              bot: { archivedAt: null },
            },
            orderBy: { createdAt: "asc" },
          });
          return rows.map(mcpAssignmentDto);
        }),
        list: authed.mcp.assignments.list.handler(async ({ context, input }) => {
          const bot = await deps.prisma.bot.findFirst({
            where: {
              id: input.botId,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
            select: { id: true },
          });
          if (!bot) throw new IsolationError();
          const rows = await deps.prisma.botMcpServer.findMany({
            where: {
              botId: bot.id,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
            orderBy: { createdAt: "asc" },
          });
          return rows.map(mcpAssignmentDto);
        }),
        approve: authed.mcp.assignments.approve.handler(async ({ context, input }) => {
          const row = await deps.prisma.$transaction(async (tx) => {
            const [bot, server] = await Promise.all([
              tx.bot.findFirst({
                where: {
                  id: input.botId,
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                },
                select: { id: true },
              }),
              tx.mcpServer.findFirst({
                where: {
                  id: input.serverId,
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                  enabled: true,
                },
                select: { id: true },
              }),
            ]);
            if (!bot || !server) throw new IsolationError();
            return tx.botMcpServer.upsert({
              where: { botId_serverId: { botId: bot.id, serverId: server.id } },
              create: {
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                botId: bot.id,
                serverId: server.id,
                allowAllTools: true,
                allowedTools: [],
              },
              update: {},
            });
          });
          return mcpAssignmentDto(row);
        }),
        replace: authed.mcp.assignments.replace.handler(async ({ context, input }) => {
          const result = await deps.prisma.$transaction(async (tx) => {
            const bot = await tx.bot.findFirst({
              where: {
                id: input.botId,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
              select: { id: true },
            });
            if (!bot) throw new IsolationError();
            const servers = await tx.mcpServer.findMany({
              where: {
                id: { in: input.assignments.map((assignment) => assignment.serverId) },
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
              select: { id: true },
            });
            if (servers.length !== input.assignments.length) throw new IsolationError();
            await tx.botMcpServer.deleteMany({
              where: {
                botId: bot.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
            });
            if (input.assignments.length)
              await tx.botMcpServer.createMany({
                data: input.assignments.map((assignment) => ({
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                  botId: bot.id,
                  serverId: assignment.serverId,
                  allowAllTools: assignment.allowAllTools,
                  allowedTools: assignment.allowedTools as Prisma.InputJsonValue,
                })),
              });
            return tx.botMcpServer.findMany({
              where: {
                botId: bot.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
              orderBy: { createdAt: "asc" },
            });
          });
          return result.map(mcpAssignmentDto);
        }),
      },
      oauth: {
        begin: authed.mcp.oauth.begin.handler(async ({ context, input }) => {
          try {
            const expectedRedirect = new URL("/mcp/oauth/callback", deps.env.webOrigin).toString();
            if (new URL(input.redirectUri).toString() !== expectedRedirect) {
              throw new Error("MCP OAuth redirect URI is not allowed");
            }
            return await mcpOAuth.begin({
              ...input,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            });
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", {
              message: error instanceof Error ? error.message : "Could not start MCP OAuth",
            });
          }
        }),
        complete: authed.mcp.oauth.complete.handler(async ({ context, input }) => {
          try {
            await mcpOAuth.complete({
              ...input,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            });
            return { ok: true as const };
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", {
              message: error instanceof Error ? error.message : "Could not complete MCP OAuth",
            });
          }
        }),
        disconnect: authed.mcp.oauth.disconnect.handler(async ({ context, input }) => {
          await mcpOAuth.disconnect({
            ...input,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          });
          return { ok: true as const };
        }),
      },
    },
  };
}
