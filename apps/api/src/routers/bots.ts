import { randomBytes } from "node:crypto";
import { runJobKey } from "@nova/adapter-kit";
import {
  archiveBot,
  cancelComputerRunWork,
  checkpointAndRecordComputerWorkspace,
  destroyBot,
  hasActiveComputerControl,
  listPiCatalog,
  modelCredentialDto,
  screenLeaseIdForRun,
  scriptedCatalogEntry,
  toComputerRef,
  validateStoredModelAuth,
} from "@nova/adapters";
import type { Actor } from "@nova/contracts";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@nova/contracts";
import { ACTIVE_RUN_STATUSES } from "@nova/core";
import {
  BotSectionNameConflictError,
  ComputerLimitError,
  findModelCredential,
  IsolationError,
  restoreBotUnderComputerQuota,
  SpaceDeletionInProgressError,
} from "@nova/db";
import { getLogger } from "@nova/logging";
import { ORPCError } from "@orpc/server";
import { botProfileLabelsChanged, commitBotUpdate } from "../bot-update.js";
import { loadMessagePage } from "../thread-message-pages.js";
import type { RouterContext, RouterDeps } from "./context.js";
import { computerContext, meDto, THREAD_MESSAGE_PAGE_SIZE } from "./shared.js";

/** Surface a Space deletion race as a retryable conflict instead of a generic failure. */
function mapSpaceLifecycleError(error: unknown): unknown {
  if (error instanceof SpaceDeletionInProgressError) {
    return new ORPCError("CONFLICT", { message: error.message });
  }
  if (error instanceof ComputerLimitError) {
    return new ORPCError("BAD_REQUEST", { message: error.message });
  }
  return error;
}

/** ADR 0001: a person has exactly one live Muse; peer-bot creation is locked. */
const MUSE_SINGLE_BOT_MESSAGE = "You already have a Muse. Only one Muse per person is allowed.";

/** The live (non-archived) bot this person already has, if any, for the single-Muse guard. */
async function findLiveBot(
  deps: RouterDeps,
  actor: Actor,
): Promise<{ id: string; spawnKey: string | null } | null> {
  return deps.prisma.bot.findFirst({
    where: { spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    select: { id: true, spawnKey: true },
  });
}

/**
 * ADR 0001: reject creating a second live bot unless this is the idempotent
 * onboarding re-create of the one the person already has (matching
 * `spawnKey`, e.g. `spawnKey: "onboarding:first"`) — that path must keep
 * returning the existing bot instead of being locked out.
 */
export function assertMuseSingleBotAllowed(
  liveBot: { spawnKey: string | null } | null,
  requestedSpawnKey: string | null | undefined,
): void {
  if (!liveBot) return;
  const requestedKey = requestedSpawnKey ?? null;
  const isIdempotentRetry = requestedKey !== null && liveBot.spawnKey === requestedKey;
  if (isIdempotentRetry) return;
  throw new ORPCError("FORBIDDEN", { message: MUSE_SINGLE_BOT_MESSAGE });
}

function duplicateBotName(name: string) {
  return `${name.slice(0, 75)} copy`;
}

export function botsRouter(c: RouterContext) {
  const { authed, repos, groupRepos, deps } = c;
  return {
    bots: {
      list: authed.bots.list.handler(async ({ context }) => repos.listBots(context.actor)),
      listArchived: authed.bots.listArchived.handler(async ({ context }) =>
        repos.listBots(context.actor, { archived: true }),
      ),
      get: authed.bots.get.handler(async ({ context, input }) => {
        const found = (await repos.listBots(context.actor)).find((bot) => bot.id === input.botId);
        if (!found) throw new IsolationError();
        return found;
      }),
      create: authed.bots.create.handler(async ({ context, input }) => {
        const liveBot = await findLiveBot(deps, context.actor);
        assertMuseSingleBotAllowed(liveBot, input.spawnKey ?? null);
        try {
          return await repos.createBot(context.actor, input);
        } catch (error) {
          throw mapSpaceLifecycleError(error);
        }
      }),
      // ADR 0001: a person has exactly one live Muse, so duplicating it is always locked.
      duplicate: authed.bots.duplicate.handler(async () => {
        throw new ORPCError("FORBIDDEN", { message: MUSE_SINGLE_BOT_MESSAGE });
      }),
      reorder: authed.bots.reorder.handler(async ({ context, input }) => {
        await repos.reorderBots(context.actor, input.botIds);
        return { ok: true as const };
      }),
      update: authed.bots.update.handler(async ({ context, input }) => {
        const existing = await repos.getBot(context.actor, input.botId);
        if (input.sectionId) {
          const section = await deps.prisma.botSection.findFirst({
            where: {
              id: input.sectionId,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
            select: { id: true },
          });
          if (!section) throw new IsolationError();
        }
        // Web settings resend the saved model on every save. Reject an
        // incompatible override only when this request is changing it; a run
        // still rejects a Spark model the subscription sign-in cannot call.
        const settingModel =
          input.modelProvider !== undefined &&
          input.modelId !== undefined &&
          (input.modelProvider !== existing.modelProvider || input.modelId !== existing.modelId);
        if (settingModel && input.modelProvider && input.modelId) {
          const credential = await findModelCredential(
            deps.prisma,
            context.actor,
            input.modelProvider,
            input.modelId,
          );
          if (!credential) {
            throw new ORPCError("BAD_REQUEST", { message: "Connect that model provider first" });
          }
          const knownModels = [...listPiCatalog(), scriptedCatalogEntry];
          const inCatalog = knownModels.some(
            (item) => item.provider === input.modelProvider && item.id === input.modelId,
          );
          if (!inCatalog && credential.defaultModel !== input.modelId) {
            throw new ORPCError("BAD_REQUEST", { message: "Unknown model for that provider" });
          }
          if (inCatalog) {
            const authError = await validateStoredModelAuth(
              deps.prisma,
              deps.secrets,
              context.actor.userId,
              credential.secretId,
              input.modelProvider,
              input.modelId,
            );
            if (authError) throw new ORPCError("BAD_REQUEST", { message: authError });
          }
        }
        const thinkingLevel = input.thinkingLevel;
        if (input.thinkingLevel) {
          const provider =
            input.modelProvider !== undefined ? input.modelProvider : existing.modelProvider;
          const modelId = input.modelId !== undefined ? input.modelId : existing.modelId;
          const me = await meDto(deps, context.actor);
          const effectiveProvider = provider ?? me.defaultProvider;
          const effectiveModelId = modelId ?? me.defaultModel;
          if (effectiveProvider && effectiveModelId) {
            const entry = listPiCatalog().find(
              (item) => item.provider === effectiveProvider && item.id === effectiveModelId,
            );
            let allowed = entry?.thinkingLevels;
            if (effectiveProvider === OPENAI_COMPATIBLE_PROVIDER_ID) {
              allowed = ["off"];
              const credential = await findModelCredential(
                deps.prisma,
                context.actor,
                effectiveProvider,
              );
              if (credential && credential.defaultModel === effectiveModelId) {
                const secret = await deps.prisma.secret.findFirst({
                  where: { id: credential.secretId, userId: context.actor.userId, spaceId: null },
                  select: { ciphertext: true },
                });
                if (secret) {
                  try {
                    allowed =
                      modelCredentialDto(
                        credential,
                        deps.secrets.load(secret.ciphertext, credential.secretId),
                      ).thinkingLevels ?? allowed;
                  } catch {
                    // Unreadable connections must not advertise reasoning support.
                  }
                }
              }
            }
            if (allowed && !allowed.includes(input.thinkingLevel)) {
              throw new ORPCError("BAD_REQUEST", {
                message: `Thinking level must be one of: ${allowed.join(", ")}`,
              });
            }
          }
        }
        if (!existing.thread) throw new IsolationError();
        await commitBotUpdate({
          prisma: deps.prisma,
          notify: (threadId, seq) => deps.events.notify(threadId, seq),
          spaceId: context.actor.spaceId,
          threadId: existing.thread.id,
          botId: input.botId,
          emitBotUpdated: botProfileLabelsChanged(input),
          data: {
            name: input.name,
            title: input.title,
            description: input.description,
            instructions: input.instructions,
            notifyOnFinish: input.notifyOnFinish,
            color: input.color,
            pinned: input.pinned,
            sectionId: input.sectionId,
            voiceId: input.voiceId,
            autoSpeak: input.autoSpeak,
            ...(input.modelProvider !== undefined
              ? { modelProvider: input.modelProvider, modelId: input.modelId ?? null }
              : {}),
            ...(input.thinkingLevel !== undefined ? { thinkingLevel } : {}),
            ...(input.teamChatAmbientEnabled !== undefined
              ? { teamChatAmbientEnabled: input.teamChatAmbientEnabled }
              : {}),
            ...(input.teamChatRules !== undefined ? { teamChatRules: input.teamChatRules } : {}),
          },
        });
        const bots = await repos.listBots(context.actor);
        const bot = bots.find((b) => b.id === input.botId);
        if (!bot) throw new IsolationError();
        return bot;
      }),
      setComputer: authed.bots.setComputer.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        const currentMode = bot.computer.scope === "dedicated" ? "dedicated" : "team";
        if (currentMode === input.mode) {
          try {
            return await repos.setBotComputer(context.actor, bot.id, input.mode);
          } catch (error) {
            throw mapSpaceLifecycleError(error);
          }
        }
        const claimed = await deps.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM computers WHERE id = ${bot.computerId} FOR UPDATE`;
          return tx.bot.updateMany({
            where: { id: bot.id, computerSwitching: false, computer: { maintenanceId: null } },
            data: { computerSwitching: true },
          });
        });
        if (claimed.count !== 1) throw new ORPCError("CONFLICT");
        try {
          const active = await deps.prisma.run.findFirst({
            where: { botId: bot.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
            select: { id: true },
          });
          if (active) {
            throw new ORPCError("BAD_REQUEST", { message: "Stop the bot first" });
          }
          if (bot.computer.controlBotId === bot.id && hasActiveComputerControl(bot.computer)) {
            throw new ORPCError("BAD_REQUEST", { message: "Release the computer first" });
          }
          if (bot.computer.scope === "dedicated" && bot.computer.providerRef) {
            const ctx = computerContext(context.actor, bot.id, "computer.switch");
            const ref = toComputerRef(bot.computer);
            if (bot.computer.state === "running") {
              await checkpointAndRecordComputerWorkspace(deps, bot.computer, ref, ctx);
              await deps.sandbox.stop(ref, ctx);
            }
            await deps.prisma.computerExecutionLease.deleteMany({
              where: { computerId: bot.computer.id, botId: bot.id },
            });
            await deps.prisma.computer.update({
              where: { id: bot.computer.id },
              data: {
                state: "stopped",
                controlHolder: "none",
                controlLeaseId: null,
                controlLeaseExpiresAt: null,
                controlBotId: null,
                controlRunId: null,
                executionRunId: null,
                executionBotId: null,
                executionLeaseExpiresAt: null,
              },
            });
          }
          return await repos.setBotComputer(context.actor, bot.id, input.mode);
        } catch (error) {
          throw mapSpaceLifecycleError(error);
        } finally {
          await deps.prisma.bot.updateMany({
            where: { id: bot.id },
            data: { computerSwitching: false },
          });
        }
      }),
      archive: authed.bots.archive.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId, { includeArchived: true });
        await archiveBot(
          {
            prisma: deps.prisma,
            sandbox: deps.sandbox,
            home: deps.home,
            jobs: deps.jobs,
            artifacts: deps.artifacts,
            dataDir: deps.dataDir,
          },
          bot,
          computerContext(context.actor, bot.id, "archive"),
        );
        return { ok: true as const };
      }),
      restore: authed.bots.restore.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId, { includeArchived: true });
        if (!bot.archivedAt) return { ok: true as const };
        const liveBot = await findLiveBot(deps, context.actor);
        if (liveBot) throw new ORPCError("FORBIDDEN", { message: MUSE_SINGLE_BOT_MESSAGE });
        try {
          if (bot.computer) {
            await restoreBotUnderComputerQuota(deps.prisma, {
              userId: context.actor.userId,
              botId: bot.id,
              computerId: bot.computer.id,
            });
          } else {
            await deps.prisma.bot.update({ where: { id: bot.id }, data: { archivedAt: null } });
          }
        } catch (error) {
          throw mapSpaceLifecycleError(error);
        }
        return { ok: true as const };
      }),
      remove: authed.bots.remove.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId, { includeArchived: true });
        await destroyBot(
          {
            prisma: deps.prisma,
            sandbox: deps.sandbox,
            home: deps.home,
            jobs: deps.jobs,
            artifacts: deps.artifacts,
            dataDir: deps.dataDir,
          },
          bot,
          {
            operationId: "destroy",
            traceId: "destroy",
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            signal: new AbortController().signal,
          },
          { deleteMemories: input.deleteMemories },
        );
        return { ok: true as const };
      }),
      rotateWebhookSecret: authed.bots.rotateWebhookSecret.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        const plaintext = randomBytes(32).toString("base64url");
        const stored = await deps.secrets.put(plaintext, {
          operationId: "bots.rotateWebhookSecret",
          traceId: "bots.rotateWebhookSecret",
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
          signal: context.signal ?? new AbortController().signal,
        });
        await deps.prisma.$transaction(async (tx) => {
          const previousSecretId = bot.webhookSecretId;
          await tx.secret.create({
            data: {
              id: stored.id,
              userId: context.actor.userId,
              spaceId: context.actor.spaceId,
              kind: "webhook",
              ciphertext: stored.ciphertext,
            },
          });
          await tx.bot.update({
            where: { id: bot.id },
            data: { webhookSecretId: stored.id },
          });
          if (previousSecretId) {
            await tx.secret.deleteMany({
              where: {
                id: previousSecretId,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                kind: "webhook",
              },
            });
          }
        });
        return {
          secret: plaintext,
          path: `/api/v1/bots/${bot.id}/webhook`,
          webhookConfigured: true as const,
        };
      }),
    },
    groups: {
      create: authed.groups.create.handler(async ({ context, input }) => {
        try {
          return await groupRepos.createGroup(context.actor, input);
        } catch (error) {
          throw mapSpaceLifecycleError(error);
        }
      }),
      list: authed.groups.list.handler(async ({ context }) => groupRepos.listGroups(context.actor)),
      listArchived: authed.groups.listArchived.handler(async ({ context }) =>
        groupRepos.listGroups(context.actor, { archived: true }),
      ),
      get: authed.groups.get.handler(async ({ context, input }) => {
        const group = await groupRepos.getGroup(context.actor, input.groupId);
        return {
          ...groupRepos.mapGroup(group),
          messages: (
            await loadMessagePage(
              deps.prisma,
              group.thread!.id,
              undefined,
              THREAD_MESSAGE_PAGE_SIZE,
            )
          ).messages,
        };
      }),
      duplicate: authed.groups.duplicate.handler(async ({ context, input }) => {
        const source = await groupRepos.getGroup(context.actor, input.groupId);
        try {
          return await groupRepos.createGroup(context.actor, {
            name: duplicateBotName(source.name),
            botIds: source.members.map((member) => member.bot.id),
          });
        } catch (error) {
          throw mapSpaceLifecycleError(error);
        }
      }),
      update: authed.groups.update.handler(async ({ context, input }) => {
        if (input.sectionId) {
          const section = await deps.prisma.botSection.findFirst({
            where: {
              id: input.sectionId,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
            select: { id: true },
          });
          if (!section) throw new IsolationError();
        }
        const updated = await groupRepos.updateGroup(context.actor, input);
        await Promise.all(
          updated.cancelledRunIds.map((runId) =>
            deps.jobs.cancel(runJobKey(runId)).catch(() => undefined),
          ),
        );
        return updated.group;
      }),
      archive: authed.groups.archive.handler(async ({ context, input }) => {
        const archived = await groupRepos.archiveGroup(context.actor, input.groupId);
        await Promise.all(
          archived.cancelledRunIds.map((runId) =>
            deps.jobs.cancel(runJobKey(runId)).catch(() => undefined),
          ),
        );
        await Promise.all(
          archived.computers.map(async (computer) => {
            if (!computer.providerRef) return;
            const adapterContext = {
              operationId: "stop",
              traceId: "stop",
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              botId: computer.botId,
              runId: computer.runId,
              screenLeaseId: screenLeaseIdForRun(
                { runId: computer.runId, fence: computer.fence },
                computer.runId,
              ),
              cancelRunWork: true,
              signal: new AbortController().signal,
            };
            const ref = toComputerRef(computer);
            await cancelComputerRunWork(
              deps.sandbox,
              ref,
              computer.id,
              computer.runId,
              adapterContext,
            );
            await deps.sandbox.releaseScreen?.(ref, adapterContext).catch(() => undefined);
          }),
        );
        // Expire the leases only after teardown: while they were live, no other run could claim
        // these screens.
        await groupRepos.releaseArchivedRunLeases(archived.cancelledRunIds);
        return { ok: true as const };
      }),
      restore: authed.groups.restore.handler(async ({ context, input }) => {
        await groupRepos.restoreGroup(context.actor, input.groupId);
        return { ok: true as const };
      }),
      remove: authed.groups.remove.handler(async ({ context, input }) => {
        const removed = await groupRepos.removeGroup(context.actor, input.groupId);
        const cleanup = await Promise.allSettled(
          removed.artifactStorageKeys.map((storageKey) =>
            deps.artifacts.remove(
              storageKey,
              computerContext(context.actor, removed.contextBotId, `group-remove:${input.groupId}`),
            ),
          ),
        );
        for (const result of cleanup) {
          if (result.status === "rejected")
            getLogger().error("group artifact cleanup", result.reason);
        }
        return { ok: true as const };
      }),
    },
    botSections: {
      list: authed.botSections.list.handler(async ({ context }) =>
        repos.listBotSections(context.actor),
      ),
      create: authed.botSections.create.handler(async ({ context, input }) =>
        repos.createBotSection(context.actor, input),
      ),
      update: authed.botSections.update.handler(async ({ context, input }) => {
        try {
          return await repos.updateBotSection(context.actor, input);
        } catch (error) {
          if (error instanceof BotSectionNameConflictError) {
            throw new ORPCError("CONFLICT", { message: error.message });
          }
          throw error;
        }
      }),
    },
  };
}
