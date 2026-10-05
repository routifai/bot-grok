import { createHash } from "node:crypto";
import {
  prepareApiInstall,
  prepareGraphqlInstall,
  sanitizeComposioError,
  verifyMcpInstall,
} from "@aiden/adapters";
import { IntegrationProviderIdSchema } from "@aiden/contracts";
import { containsSecret } from "@aiden/core";
import type { Prisma } from "@aiden/db";
import { ORPCError } from "@orpc/server";
import { searchIntegrationCatalog } from "../integration-catalog.js";
import {
  chooseFocus,
  dismissFocus,
  markAppConnected,
  promptFocus,
  startOnboarding,
} from "../onboarding.js";

import type { RouterContext } from "./context.js";
import { connectionContext } from "./shared.js";

export function integrationsRouter(c: RouterContext) {
  const { authed, onboardingDeps, deps } = c;
  return {
    capabilities: {
      list: authed.capabilities.list.handler(async ({ context }) => {
        const rows = await deps.prisma.capabilityInstall.findMany({
          where: { spaceId: context.actor.spaceId, userId: context.actor.userId },
        });
        return rows.map((row) => ({
          id: row.id,
          kind: row.kind as "skill" | "plugin" | "mcp" | "api" | "connection",
          name: row.name,
          source: row.source,
          version: row.version,
          digest: row.digest,
          secretConfigured: Boolean(row.secretId),
          config: row.config as Record<string, unknown>,
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      catalogSearch: authed.capabilities.catalogSearch.handler(async ({ context, input }) => {
        const baseUrl =
          deps.env.integrationsCatalogUrl ??
          (input.usePublicCatalog ? "https://integrations.sh" : undefined);
        if (!baseUrl) return { enabled: false, results: [] };
        try {
          const results = await searchIntegrationCatalog({
            baseUrl,
            query: input.query,
            signal: context.signal ?? new AbortController().signal,
            fetch: deps.remoteConnectors?.fetch,
          });
          return { enabled: true, results };
        } catch (error) {
          throw new ORPCError("BAD_GATEWAY", {
            message: error instanceof Error ? error.message : "Integration catalog search failed",
          });
        }
      }),
      install: authed.capabilities.install.handler(async ({ context, input }) => {
        let source = input.source.trim();
        let config = input.config;
        const credential = input.credential?.trim() || undefined;
        if (
          credential &&
          credential.length >= 8 &&
          (source.includes(credential) || containsSecret(config, [credential]))
        ) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Put credentials only in the encrypted credential field",
          });
        }
        if (JSON.stringify(config).length > 2_000_000) {
          throw new ORPCError("BAD_REQUEST", { message: "Capability configuration is too large" });
        }
        if (
          credential &&
          input.kind !== "mcp" &&
          input.kind !== "api" &&
          input.kind !== "graphql"
        ) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Credentials are only accepted for MCP, API, and GraphQL tool sources",
          });
        }
        try {
          if (input.kind === "mcp") {
            if (config.preset === "treg") {
              source = "https://treg.to/mcp/";
              config = { ...config, preset: "treg", auth: { type: "bearer" } };
            }
            const verified = await verifyMcpInstall({
              source,
              config,
              credential,
              signal: context.signal,
              remote: deps.remoteConnectors,
            });
            config = verified.config;
          }
          if (input.kind === "api") {
            const prepared = await prepareApiInstall({
              source,
              config,
              credential,
              signal: context.signal,
              remote: deps.remoteConnectors,
            });
            source = prepared.source;
            config = prepared.config;
          }
          if (input.kind === "graphql") {
            const prepared = await prepareGraphqlInstall({
              source,
              config,
              credential,
              signal: context.signal,
              remote: deps.remoteConnectors,
            });
            source = prepared.source;
            config = prepared.config;
          }
        } catch (error) {
          const message = sanitizeComposioError(error);
          throw new ORPCError("BAD_REQUEST", {
            message: credential ? message.split(credential).join("[redacted]") : message,
          });
        }
        const stored = credential
          ? await deps.secrets.put(credential, {
              operationId: "capabilities.install",
              traceId: "capabilities.install",
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              signal: context.signal ?? new AbortController().signal,
            })
          : undefined;
        const digest = `sha256:${createHash("sha256")
          .update(JSON.stringify({ kind: input.kind, source, config }))
          .digest("hex")}`;
        const row = await deps.prisma.$transaction(async (tx) => {
          if (stored) {
            await tx.secret.create({
              data: {
                id: stored.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                kind: "connector",
                ciphertext: stored.ciphertext,
              },
            });
          }
          return tx.capabilityInstall.create({
            data: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              kind: input.kind,
              name: input.name.trim(),
              source,
              secretId: stored?.id,
              config: config as Prisma.InputJsonValue,
              digest,
              version: "1.0.0",
            },
          });
        });
        return {
          id: row.id,
          kind: row.kind as "skill" | "plugin" | "mcp" | "api" | "connection",
          name: row.name,
          source: row.source,
          version: row.version,
          digest: row.digest,
          secretConfigured: Boolean(row.secretId),
          config: row.config as Record<string, unknown>,
          createdAt: row.createdAt.toISOString(),
        };
      }),
      remove: authed.capabilities.remove.handler(async ({ context, input }) => {
        await deps.prisma.$transaction(async (tx) => {
          const existing = await tx.capabilityInstall.findFirst({
            where: {
              id: input.id,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
          });
          if (!existing) return;
          await tx.capabilityInstall.delete({ where: { id: existing.id } });
          if (existing.secretId) {
            const shared = await tx.capabilityInstall.count({
              where: { secretId: existing.secretId },
            });
            if (shared === 0) {
              await tx.secret.deleteMany({
                where: {
                  id: existing.secretId,
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                },
              });
            }
          }
        });
        return { ok: true as const };
      }),
    },
    onboarding: {
      start: authed.onboarding.start.handler(async ({ context, input }) => {
        await startOnboarding(onboardingDeps, context.actor, input.botId);
        return { ok: true as const };
      }),
      promptFocus: authed.onboarding.promptFocus.handler(async ({ context, input }) => {
        await promptFocus(onboardingDeps, context.actor, input.botId);
        return { ok: true as const };
      }),
      choose: authed.onboarding.choose.handler(async ({ context, input }) => {
        await chooseFocus(onboardingDeps, context.actor, input.botId, input.optionId);
        return { ok: true as const };
      }),
      dismissFocus: authed.onboarding.dismissFocus.handler(async ({ context, input }) => {
        await dismissFocus(onboardingDeps, context.actor, input.botId);
        return { ok: true as const };
      }),
      appConnected: authed.onboarding.appConnected.handler(async ({ context, input }) => {
        await markAppConnected(
          onboardingDeps,
          context.actor,
          input.botId,
          input.provider,
          input.connectorId,
        );
        return { ok: true as const };
      }),
    },
    integrationSetup: {
      get: authed.integrationSetup.get.handler(async ({ context }) => {
        const canConfigure = context.actor.isDeploymentOwner;
        const providers = canConfigure
          ? await Promise.all(
              IntegrationProviderIdSchema.options.map(async (id) => ({
                id,
                configured: deps.integrationSettings
                  ? await deps.integrationSettings.configured(id)
                  : Boolean(deps.connectors.managed(id)),
              })),
            )
          : [];
        return {
          canConfigure,
          needsSetup: canConfigure && !providers.some((provider) => provider.configured),
          webUrl: new URL("/integrations/setup", deps.env.webOrigin).toString(),
          providers,
        };
      }),
      save: authed.integrationSetup.save.handler(async ({ context, input }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        if (!deps.integrationSettings) throw new ORPCError("NOT_IMPLEMENTED");
        try {
          await deps.integrationSettings.save(
            input,
            connectionContext(context.actor, "integrationSetup.save", context.signal),
          );
        } catch {
          throw new ORPCError("BAD_REQUEST", {
            message: "Could not verify or save these credentials",
          });
        }
        return { ok: true as const };
      }),
    },
  };
}
