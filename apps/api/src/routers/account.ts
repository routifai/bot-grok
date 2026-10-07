import { deletePushToken, savePushToken, toComputerRef } from "@aiden/adapters";
import type { Actor, Me, SpaceNavigation } from "@aiden/contracts";
import { validTimezoneOrUtc } from "@aiden/core";
import type { PrismaClient } from "@aiden/db";
import {
  CannotDeleteDefaultSpaceError,
  CannotDeleteLastSpaceError,
  CannotDeleteSpaceAsNonOwnerError,
  claimEmptySpaceDeletionForMember,
  createExternalConversationRepos,
  type createGroupRepos,
  type createRepos,
  createSpaceForMember,
  deleteEmptySpaceForMember,
  InvalidSpaceNameError,
  IsolationError,
  releaseSpaceDeletionClaim,
  renewSpaceDeletionClaim,
  SPACE_DELETION_CLAIM_TIMEOUT_MS,
  SpaceDeletionInProgressError,
  SpaceLimitError,
  SpaceNotEmptyError,
  SpaceNotFoundError,
} from "@aiden/db";
import { getLogger } from "@aiden/logging";
import { ORPCError } from "@orpc/server";
import { aiConsentStatus, allowAiConsent } from "../ai-consent.js";
import { withEngineComputer } from "../engine-computer.js";
import { syncEngineTimezone } from "../engine-timezone.js";
import { listSpaceRuns } from "../runs.js";
import { engineSearch, querySpaceSearch } from "../search.js";
import { loadAllMessages } from "../thread-message-pages.js";
import { resolveThreadTarget, threadSnapshot } from "../thread-target.js";
import type { RouterContext, RouterDeps } from "./context.js";
import { computerHostFor, connectionContext, listRoutinesDto, meDto } from "./shared.js";

const EXPORT_MESSAGE_PAGE_SIZE = 500;

/** Bound for one provider sandbox destroy during Space deletion. Providers may
 * ignore the request abort signal, so without a deadline a hung destroy would
 * keep the deletion claim renewed forever and block stale-claim recovery. */
const SPACE_TEARDOWN_TIMEOUT_MS = 120_000;

function spaceTeardownTimeoutMs(): number {
  const override = Number(process.env.SPACE_TEARDOWN_TIMEOUT_MS ?? "");
  return Number.isFinite(override) && override > 0 ? override : SPACE_TEARDOWN_TIMEOUT_MS;
}

async function spaceNavigationDto(
  deps: RouterDeps,
  actor: Actor,
  repos: ReturnType<typeof createRepos>,
  groupRepos: ReturnType<typeof createGroupRepos>,
): Promise<SpaceNavigation> {
  const currentSpace = await deps.prisma.space.findUnique({
    where: { id: actor.spaceId },
    select: { organizationId: true },
  });
  if (!currentSpace) throw new IsolationError();
  const memberships = await deps.prisma.spaceMember.findMany({
    where: { userId: actor.userId, organizationId: currentSpace.organizationId },
    select: {
      spaceId: true,
      role: true,
      space: { select: { name: true, isDefault: true, deletingAt: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const spaceIds = memberships.map((membership) => membership.spaceId);
  const inactiveSpaceIds = spaceIds.filter((spaceId) => spaceId !== actor.spaceId);
  const [
    currentBots,
    currentGroups,
    inactiveBots,
    inactiveGroups,
    botSections,
    externalConversations,
    contentBots,
    contentGroups,
  ] = await Promise.all([
    repos.listBots(actor),
    groupRepos.listGroups(actor),
    repos.listSpaceBotsForSpaces(actor, inactiveSpaceIds),
    groupRepos.listSpaceGroupsForSpaces(actor, inactiveSpaceIds),
    repos.listBotSectionsForSpaces(actor, spaceIds),
    createExternalConversationRepos(deps.prisma).listForSpaces(actor, spaceIds),
    // Active-only navigation lists miss archived content in other spaces; count any
    // bot/group in the actor's spaces (including another member's) so a shared
    // non-empty space cannot look empty for onboarding redirects.
    deps.prisma.bot.findMany({
      where: { spaceId: { in: spaceIds } },
      select: { spaceId: true },
      distinct: ["spaceId"],
    }),
    deps.prisma.chatGroup.findMany({
      where: { spaceId: { in: spaceIds } },
      select: { spaceId: true },
      distinct: ["spaceId"],
    }),
  ]);
  const spacesWithContent = new Set([
    ...contentBots.map((row) => row.spaceId),
    ...contentGroups.map((row) => row.spaceId),
  ]);
  const currentMembership = memberships.find((membership) => membership.spaceId === actor.spaceId);
  if (!currentMembership) throw new IsolationError();
  const botsBySpace = partitionBySpace([...currentBots, ...inactiveBots]);
  const groupsBySpace = partitionBySpace([...currentGroups, ...inactiveGroups]);
  const sectionsBySpace = partitionBySpace(botSections);
  const botsFor = (spaceId: string) => botsBySpace.get(spaceId) ?? [];
  const groupsFor = (spaceId: string) => groupsBySpace.get(spaceId) ?? [];
  const sectionsFor = (spaceId: string) => sectionsBySpace.get(spaceId) ?? [];
  const staleClaimBefore = new Date(Date.now() - SPACE_DELETION_CLAIM_TIMEOUT_MS);

  return {
    current: {
      id: actor.spaceId,
      name: currentMembership.space.name,
      bots: currentBots,
      groups: currentGroups,
      externalConversations: externalConversations.filter(
        (conversation) => conversation.spaceId === actor.spaceId,
      ),
      botSections: sectionsFor(actor.spaceId),
    },
    spaces: memberships.map((membership) => {
      const spaceBots = botsFor(membership.spaceId);
      const spaceGroups = groupsFor(membership.spaceId);
      return {
        id: membership.spaceId,
        name: membership.space.name,
        isDefault: membership.space.isDefault,
        hasContent: spacesWithContent.has(membership.spaceId),
        canDelete:
          membership.role === "owner" &&
          !membership.space.isDefault &&
          memberships.length > 1 &&
          !spacesWithContent.has(membership.spaceId) &&
          (membership.space.deletingAt === null || membership.space.deletingAt < staleClaimBefore),
        bots: spaceBots.map((bot) => ({
          id: bot.id,
          parentBotId: bot.parentBotId,
          spaceId: bot.spaceId,
          name: bot.name,
          title: bot.title,
          color: bot.color,
          notifyOnFinish: bot.notifyOnFinish,
          pinned: bot.pinned,
          sectionId: bot.sectionId,
          unread: bot.unread,
          preview: bot.preview,
          status: bot.status,
          updatedAt: bot.updatedAt,
        })),
        groups: spaceGroups.map((group) => ({
          id: group.id,
          spaceId: group.spaceId,
          name: group.name,
          pinned: group.pinned,
          sectionId: group.sectionId,
          members: group.members,
          preview: group.preview,
          unread: group.unread,
          updatedAt: group.updatedAt,
        })),
        externalConversations: externalConversations.filter(
          (conversation) => conversation.spaceId === membership.spaceId,
        ),
        botSections: sectionsFor(membership.spaceId),
      };
    }),
  };
}

function partitionBySpace<T extends { spaceId: string }>(rows: T[]): Map<string, T[]> {
  const partitioned = new Map<string, T[]>();
  for (const row of rows) {
    const spaceRows = partitioned.get(row.spaceId) ?? [];
    spaceRows.push(row);
    partitioned.set(row.spaceId, spaceRows);
  }
  return partitioned;
}

async function deploymentDto(prisma: PrismaClient, sandboxProvider: string) {
  const settings = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
  return {
    ownerUserId: settings?.ownerUserId ?? null,
    signupsEnabled: settings?.signupsEnabled ?? true,
    signupAllowlist: settings?.signupAllowlist
      ? settings.signupAllowlist.split(",").filter(Boolean)
      : [],
    hasDeploymentModelCredential: Boolean(settings?.deploymentModelCredentialCipher),
    defaultProvider: settings?.defaultModelProvider ?? null,
    defaultModel: settings?.defaultModelId ?? null,
    computerHost: computerHostFor(settings?.computerHost, sandboxProvider),
    canChooseHostComputer: sandboxProvider === "docker",
    sandboxProvider,
  };
}

export function accountRouter(c: RouterContext) {
  const { os, authed, repos, groupRepos, deps } = c;
  return {
    aiConsent: {
      status: authed.aiConsent.status.handler(({ context, input }) =>
        aiConsentStatus(deps, context.actor, input),
      ),
      allow: authed.aiConsent.allow.handler(({ context, input }) =>
        allowAiConsent(deps, context.actor, input),
      ),
      revoke: authed.aiConsent.revoke.handler(async ({ context, input }) => {
        await deps.prisma.aiDataConsent.deleteMany({
          where: {
            userId: context.actor.userId,
            spaceId: context.actor.spaceId,
            recipientKey: input.key ?? undefined,
          },
        });
        return aiConsentStatus(deps, context.actor);
      }),
    },
    health: os.health.handler(async () => ({ ok: true as const, version: "0.1.0" })),
    me: authed.me.handler(async ({ context }): Promise<Me> => meDto(deps, context.actor)),
    preferences: {
      update: authed.preferences.update.handler(async ({ context, input }): Promise<Me> => {
        const data: { avatarStyle?: string; timezone?: string } = {};
        if (input.avatarStyle !== undefined) data.avatarStyle = input.avatarStyle;
        if (input.timezone !== undefined) data.timezone = validTimezoneOrUtc(input.timezone);
        if (Object.keys(data).length > 0) {
          await deps.prisma.user.update({ where: { id: context.actor.userId }, data });
          if (data.timezone) await syncEngineTimezone(deps.prisma, context.actor.userId);
        }
        return meDto(deps, context.actor);
      }),
    },
    bootstrap: authed.bootstrap.handler(async ({ context, input }) => {
      const actor = context.actor;
      const [me, navigation, archivedBots, archivedGroups] = await Promise.all([
        meDto(deps, actor),
        spaceNavigationDto(deps, actor, repos, groupRepos),
        repos.listBots(actor, { archived: true }),
        groupRepos.listGroups(actor, { archived: true }),
      ]);
      const { bots, groups, botSections } = navigation.current;
      const active = bots.find((bot) => bot.id === input.botId) ?? bots[0];
      const [thread, routines] = active
        ? await Promise.all([
            resolveThreadTarget(deps.prisma, actor, { botId: active.id })
              .then((target) => threadSnapshot(deps, target))
              .then((snapshot) => withEngineComputer(deps, actor, snapshot)),
            listRoutinesDto(deps, actor, active.id),
          ])
        : [null, []];
      return {
        me,
        bots,
        groups,
        botSections,
        archivedBots,
        archivedGroups,
        thread,
        routines,
        spaces: navigation.spaces,
      };
    }),
    deployment: {
      get: authed.deployment.get.handler(async ({ context }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        return deploymentDto(deps.prisma, deps.env.sandboxProvider);
      }),
      update: authed.deployment.update.handler(async ({ context, input }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        if (input.computerHost === "this-mac" && deps.env.sandboxProvider !== "docker") {
          throw new ORPCError("BAD_REQUEST", {
            message:
              "This Mac mode is only available when SANDBOX_PROVIDER=docker on a personal local app.",
          });
        }
        await deps.prisma.deploymentSettings.upsert({
          where: { id: "default" },
          create: {
            id: "default",
            ownerUserId: context.actor.userId,
            signupsEnabled: input.signupsEnabled ?? true,
            signupAllowlist: (input.signupAllowlist ?? []).join(","),
            signupPolicyInitialized: true,
            computerHost: input.computerHost ?? undefined,
          },
          update: {
            ...(input.signupsEnabled === undefined ? {} : { signupsEnabled: input.signupsEnabled }),
            ...(input.signupAllowlist ? { signupAllowlist: input.signupAllowlist.join(",") } : {}),
            ...(input.signupsEnabled === undefined && input.signupAllowlist === undefined
              ? {}
              : { signupPolicyInitialized: true }),
            ...(input.computerHost === undefined ? {} : { computerHost: input.computerHost }),
          },
        });
        return deploymentDto(deps.prisma, deps.env.sandboxProvider);
      }),
    },
    spaces: {
      list: authed.spaces.list.handler(async ({ context }) =>
        spaceNavigationDto(deps, context.actor, repos, groupRepos),
      ),
      create: authed.spaces.create.handler(async ({ context, input }) => {
        let space: { id: string; name: string };
        try {
          space = await createSpaceForMember(deps.prisma, {
            currentSpaceId: context.actor.spaceId,
            userId: context.actor.userId,
            name: input.name,
          });
        } catch (error) {
          if (error instanceof SpaceLimitError || error instanceof InvalidSpaceNameError) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        }
        return {
          id: space.id,
          name: space.name,
          isDefault: false,
          hasContent: false,
          canDelete: true,
          bots: [],
          groups: [],
          externalConversations: [],
          botSections: [],
        };
      }),
      remove: authed.spaces.remove.handler(async ({ context, input }) => {
        let claimId: string | null = null;
        let claimActive = false;
        let claimHealthy = true;
        let claimReleasable = false;
        let claimRenewal: ReturnType<typeof setInterval> | null = null;
        const deleteInput = {
          currentSpaceId: context.actor.spaceId,
          userId: context.actor.userId,
          spaceId: input.spaceId,
        };
        try {
          // Claim emptiness before external teardown. Bot and group creation
          // take the same lifecycle lock and reject the Space until deletion
          // finishes or this claim is released.
          const claim = await claimEmptySpaceDeletionForMember(deps.prisma, deleteInput);
          claimId = claim.claimId;
          claimActive = true;
          // A recovered worker can safely finish deletion, but cannot know
          // whether the previous worker still has provider teardown in flight.
          // Keep the Space claimed on failure so content cannot reuse it.
          claimReleasable = !claim.recovered;
          const claimedInput = { ...deleteInput, claimId };
          const assertClaim = async () => {
            if (!claimHealthy) throw new SpaceDeletionInProgressError();
            try {
              const renewed = await renewSpaceDeletionClaim(deps.prisma, claimedInput);
              if (!renewed) {
                claimHealthy = false;
                claimReleasable = false;
                throw new SpaceDeletionInProgressError();
              }
            } catch (error) {
              claimHealthy = false;
              claimReleasable = false;
              throw error;
            }
          };
          claimRenewal = setInterval(() => {
            void assertClaim().catch((renewalError) => {
              if (claimActive) {
                getLogger().error("space deletion claim renewal failed", renewalError);
              }
            });
          }, SPACE_DELETION_CLAIM_TIMEOUT_MS / 5);
          const adapterContext = connectionContext(context.actor, "spaces.remove", context.signal);
          for (const computer of claim.computers) {
            await assertClaim();
            // Provider errors are ambiguous: teardown may have reached the
            // remote service. From this point, only successful deletion may
            // unblock content creation; a stale recovery must finish it.
            claimReleasable = false;
            let teardownTimer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                deps.sandbox.destroy(toComputerRef(computer), {
                  ...adapterContext,
                  botId: computer.homeKey,
                }),
                new Promise<never>((_, reject) => {
                  teardownTimer = setTimeout(() => {
                    // Stop renewal so the claim goes stale and a later
                    // worker can recover; never release after teardown
                    // started, since the hung destroy may still complete.
                    claimHealthy = false;
                    claimReleasable = false;
                    reject(new Error("Space sandbox teardown timed out"));
                  }, spaceTeardownTimeoutMs());
                }),
              ]);
            } finally {
              if (teardownTimer !== undefined) clearTimeout(teardownTimer);
            }
            // Never clear a provider handle after this worker loses its claim.
            await assertClaim();
            await deps.prisma.computer.updateMany({
              where: {
                spaceId: input.spaceId,
                homeKey: computer.homeKey,
                providerRef: computer.providerRef,
                space: { deletionClaimId: claimId },
              },
              data: { state: "stopped", providerRef: null },
            });
          }
          await assertClaim();
          claimActive = false;
          if (claimRenewal) {
            clearInterval(claimRenewal);
            claimRenewal = null;
          }
          const fallback = await deleteEmptySpaceForMember(deps.prisma, claimedInput);
          return { ok: true as const, activeSpaceId: fallback.id };
        } catch (error) {
          if (context.signal?.aborted) claimReleasable = false;
          if (claimId && claimReleasable) {
            await releaseSpaceDeletionClaim(deps.prisma, { ...deleteInput, claimId }).catch(
              (releaseError) => {
                getLogger().error("space deletion claim release failed", releaseError);
              },
            );
          }
          if (error instanceof SpaceNotFoundError) {
            throw new ORPCError("NOT_FOUND", { message: error.message });
          }
          if (error instanceof CannotDeleteSpaceAsNonOwnerError) {
            throw new ORPCError("FORBIDDEN", { message: error.message });
          }
          if (error instanceof SpaceDeletionInProgressError) {
            throw new ORPCError("CONFLICT", { message: error.message });
          }
          if (
            error instanceof CannotDeleteDefaultSpaceError ||
            error instanceof CannotDeleteLastSpaceError ||
            error instanceof SpaceNotEmptyError
          ) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        } finally {
          claimActive = false;
          if (claimRenewal) clearInterval(claimRenewal);
        }
      }),
    },
    usage: {
      list: authed.usage.list.handler(async ({ context }) => {
        const rows = await deps.prisma.usageRecord.findMany({
          where: { spaceId: context.actor.spaceId, userId: context.actor.userId },
          orderBy: { createdAt: "desc" },
          take: 100,
        });
        return rows.map((row) => ({
          id: row.id,
          botId: row.botId,
          runId: row.runId,
          provider: row.provider,
          model: row.model,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      summary: authed.usage.summary.handler(async ({ context }) => {
        const result = await deps.prisma.usageRecord.aggregate({
          where: { spaceId: context.actor.spaceId, userId: context.actor.userId },
          _sum: { inputTokens: true, outputTokens: true },
          _count: { _all: true },
        });
        return {
          inputTokens: result._sum.inputTokens ?? 0,
          outputTokens: result._sum.outputTokens ?? 0,
          runs: result._count._all,
        };
      }),
    },
    export: {
      bot: authed.export.bot.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.thread || !bot.computer) throw new IsolationError();
        const homeKey = bot.computer.homeKey;
        const exportContext = {
          operationId: "export",
          traceId: "export",
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
          signal: new AbortController().signal,
        };
        const [routines, files, history] = await Promise.all([
          deps.prisma.routine.findMany({
            where: { botId: input.botId, spaceId: context.actor.spaceId },
          }),
          (async () => {
            const exported: Array<{ path: string; content: string }> = [];
            for await (const file of deps.home.exportHome(homeKey, exportContext)) {
              exported.push({
                path: file.path,
                content: new TextDecoder().decode(file.content),
              });
            }
            return exported;
          })(),
          loadAllMessages(deps.prisma, bot.thread.id, EXPORT_MESSAGE_PAGE_SIZE),
        ]);
        return {
          version: 1 as const,
          exportedAt: new Date().toISOString(),
          bot: {
            name: bot.name,
            title: bot.title,
            description: bot.description,
            instructions: bot.instructions,
          },
          routines: routines.map((r) => ({
            name: r.name,
            prompt: r.prompt,
            crons: r.crons,
            timezone: r.timezone,
          })),
          files,
          history,
        };
      }),
    },
    notifications: {
      registerPush: authed.notifications.registerPush.handler(async ({ context, input }) => {
        await savePushToken(deps.dataDir, context.actor.userId, input.token);
        return { ok: true as const };
      }),
      unregisterPush: authed.notifications.unregisterPush.handler(async ({ context }) => {
        await deletePushToken(deps.dataDir, context.actor.userId);
        return { ok: true as const };
      }),
    },
    search: {
      query: authed.search.query.handler(async ({ context, input }) => ({
        hits: await querySpaceSearch(
          deps.prisma,
          context.actor,
          input.q,
          await engineSearch(deps.prisma, context.actor),
        ),
      })),
    },
    runs: {
      list: authed.runs.list.handler(async ({ context, input }) => ({
        runs: await listSpaceRuns(deps.prisma, context.actor, input.filter),
      })),
    },
  };
}
