import {
  deploymentAutoReviewDefault,
  isAutoReviewCheckerConfigured,
  resolveAutoReviewChecker,
} from "@aiden/adapters";
import type { Actor } from "@aiden/contracts";
import { deleteAgentSecret, listAgentSecrets, putAgentSecret } from "../agent-secrets.js";
import { listApprovalRules, revokeApprovalRule, setApprovalSpending } from "../engine-approvals.js";
import { engineComputerClient } from "../engine-computer.js";
import type { RouterContext, RouterDeps } from "./context.js";

async function loadAutoReviewSettings(deps: RouterDeps, actor: Actor) {
  const environmentAvailable = isAutoReviewCheckerConfigured({ env: process.env });
  const checker = environmentAvailable ? null : resolveAutoReviewChecker(process.env);
  const requiredUserProvider = checker?.provider === "scripted" ? null : checker?.provider;
  const [preference, credential] = await Promise.all([
    deps.prisma.actionAutoReviewPreference.findUnique({
      where: {
        spaceId_userId: {
          spaceId: actor.spaceId,
          userId: actor.userId,
        },
      },
      select: { enabled: true },
    }),
    requiredUserProvider
      ? deps.prisma.userModelCredential.findFirst({
          where: { userId: actor.userId, provider: requiredUserProvider },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);
  const enabled = preference?.enabled ?? deploymentAutoReviewDefault(process.env);
  const checkerAvailable = environmentAvailable || Boolean(credential);
  return { enabled, checkerAvailable };
}

export function approvalsRouter(c: RouterContext) {
  const { authed, museOnly, deps } = c;
  return {
    approvalRules: {
      list: authed.approvalRules.list.handler(async ({ context }) => {
        const rows = await deps.prisma.actionApprovalRule.findMany({
          where: {
            spaceId: context.actor.spaceId,
            createdByUserId: context.actor.userId,
          },
          orderBy: { createdAt: "asc" },
        });
        return rows.map((row) => ({
          id: row.id,
          effect: row.effect as "always_allow" | "require_approval",
          matchKind: row.matchKind as "tool" | "connector" | "category",
          matchValue: row.matchValue,
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      set: authed.approvalRules.set.handler(async ({ context, input }) => {
        const row = await deps.prisma.actionApprovalRule.upsert({
          where: {
            spaceId_createdByUserId_effect_matchKind_matchValue: {
              spaceId: context.actor.spaceId,
              createdByUserId: context.actor.userId,
              effect: input.effect,
              matchKind: input.matchKind,
              matchValue: input.matchValue,
            },
          },
          create: {
            spaceId: context.actor.spaceId,
            createdByUserId: context.actor.userId,
            effect: input.effect,
            matchKind: input.matchKind,
            matchValue: input.matchValue,
          },
          update: {},
        });
        return {
          id: row.id,
          effect: row.effect as "always_allow" | "require_approval",
          matchKind: row.matchKind as "tool" | "connector" | "category",
          matchValue: row.matchValue,
          createdAt: row.createdAt.toISOString(),
        };
      }),
      remove: authed.approvalRules.remove.handler(async ({ context, input }) => {
        await deps.prisma.actionApprovalRule.deleteMany({
          where: {
            id: input.id,
            spaceId: context.actor.spaceId,
            createdByUserId: context.actor.userId,
          },
        });
        return { ok: true as const };
      }),
    },
    autoReview: {
      get: authed.autoReview.get.handler(async ({ context }) => {
        return loadAutoReviewSettings(deps, context.actor);
      }),
      set: authed.autoReview.set.handler(async ({ context, input }) => {
        await deps.prisma.actionAutoReviewPreference.upsert({
          where: {
            spaceId_userId: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
          },
          create: {
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            enabled: input.enabled,
          },
          update: { enabled: input.enabled },
        });
        return loadAutoReviewSettings(deps, context.actor);
      }),
    },
    approvals: {
      rules: museOnly.approvals.rules.handler(({ context, input }) =>
        listApprovalRules(deps, engineComputerClient(context.actor), context.actor, input.botId),
      ),
      revoke: museOnly.approvals.revoke.handler(({ context, input }) =>
        revokeApprovalRule(deps, engineComputerClient(context.actor), context.actor, input),
      ),
      setSpending: museOnly.approvals.setSpending.handler(({ context, input }) =>
        setApprovalSpending(deps, engineComputerClient(context.actor), context.actor, input),
      ),
    },
    agentSecrets: {
      list: authed.agentSecrets.list.handler(async ({ context }) =>
        listAgentSecrets({ prisma: deps.prisma, secrets: deps.secrets }, context.actor),
      ),
      put: authed.agentSecrets.put.handler(async ({ context, input, signal }) =>
        putAgentSecret(
          { prisma: deps.prisma, secrets: deps.secrets },
          context.actor,
          input,
          signal,
        ),
      ),
      remove: authed.agentSecrets.remove.handler(async ({ context, input }) =>
        deleteAgentSecret({ prisma: deps.prisma, secrets: deps.secrets }, context.actor, input.id),
      ),
    },
  };
}
