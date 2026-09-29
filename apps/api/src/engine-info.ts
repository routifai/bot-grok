import { listNovaHarnesses, resolveMuseHarnessId } from "@aiden/adapters";
import type { Actor, EngineInfo, NovaHarnessId } from "@aiden/contracts";
import { IsolationError, type PrismaClient } from "@aiden/db";
import { ORPCError } from "@orpc/server";

// Real engine.info / engine.setHarness handlers (packages/contracts/src/rpc.ts): lets a person
// see and choose which Omnigent harness (packages/adapters/src/omnigent/harnesses.ts) their
// Muse's Conversation turns run on, and switch mid-Conversation — docs/omnigent-spike.md.
//
// Persistence: the nullable Bot.museHarness column (packages/db/prisma/schema.prisma), the
// same per-bot-settings-on-Bot pattern muse-settings.ts uses. Null means "use the deployment
// default" (today's single OMNIGENT_AGENT_NAME, resolved by resolveMuseHarnessId).

export interface EngineInfoDeps {
  prisma: PrismaClient;
}

/** The Muse's bot must belong to the actor's space and user, like every other bot-scoped route. */
async function requireOwnBot(
  deps: EngineInfoDeps,
  actor: Actor,
  botId: string,
): Promise<{ museHarness: string | null }> {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
    select: { museHarness: true },
  });
  if (!bot) throw new IsolationError();
  return bot;
}

function buildEngineInfo(museHarness: string | null, env: NodeJS.ProcessEnv): EngineInfo {
  const enabled = env.NOVA_ENGINE === "omnigent";
  return {
    enabled,
    active: enabled ? resolveMuseHarnessId(museHarness, env) : null,
    harnesses: listNovaHarnesses(env),
  };
}

export async function getEngineInfo(
  deps: EngineInfoDeps,
  actor: Actor,
  botId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EngineInfo> {
  const bot = await requireOwnBot(deps, actor, botId);
  return buildEngineInfo(bot.museHarness, env);
}

export async function setEngineHarness(
  deps: EngineInfoDeps,
  actor: Actor,
  input: { botId: string; harness: NovaHarnessId },
  env: NodeJS.ProcessEnv = process.env,
): Promise<EngineInfo> {
  if (env.NOVA_ENGINE !== "omnigent") {
    throw new ORPCError("BAD_REQUEST", {
      message: "Nova is not running on the Omnigent engine",
    });
  }
  await requireOwnBot(deps, actor, input.botId);

  const target = listNovaHarnesses(env).find((harness) => harness.id === input.harness);
  if (!target?.available) {
    throw new ORPCError("BAD_REQUEST", {
      message: target?.unavailableReason ?? "That harness is not available",
    });
  }

  const bot = await deps.prisma.bot.update({
    where: { id: input.botId },
    data: { museHarness: input.harness },
    select: { museHarness: true },
  });
  return buildEngineInfo(bot.museHarness, env);
}
