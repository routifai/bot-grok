import {
  listNovaHarnesses,
  resolveMuseHarnessId,
  resolveMuseRunnerLocation,
} from "@aiden/adapters";
import type { Actor, EngineInfo, NovaHarnessId, NovaRunnerLocationId } from "@aiden/contracts";
import { IsolationError, type PrismaClient } from "@aiden/db";
import { ORPCError } from "@orpc/server";

// Real engine.info / engine.setHarness / engine.setRunnerLocation handlers
// (packages/contracts/src/rpc.ts): lets a person see and choose which Omnigent harness
// (packages/adapters/src/omnigent/harnesses.ts) their Muse's Conversation turns run on and where
// its runner executes (packages/adapters/src/omnigent/runner-location.ts), and switch either
// mid-Conversation — docs/omnigent-spike.md.
//
// Persistence: the nullable Bot.museHarness / Bot.museRunnerLocation columns
// (packages/db/prisma/schema.prisma), the same per-bot-settings-on-Bot pattern muse-settings.ts
// uses. Null means "use the deployment default" (today's single OMNIGENT_AGENT_NAME for harness,
// resolved by resolveMuseHarnessId; "computer" for runner location).

export interface EngineInfoDeps {
  prisma: PrismaClient;
}

interface EngineBotRow {
  museHarness: string | null;
  museRunnerLocation: string | null;
}

/** The Muse's bot must belong to the actor's space and user, like every other bot-scoped route. */
async function requireOwnBot(
  deps: EngineInfoDeps,
  actor: Actor,
  botId: string,
): Promise<EngineBotRow> {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
    select: { museHarness: true, museRunnerLocation: true },
  });
  if (!bot) throw new IsolationError();
  return bot;
}

function buildEngineInfo(bot: EngineBotRow, env: NodeJS.ProcessEnv): EngineInfo {
  const enabled = env.NOVA_ENGINE === "omnigent";
  return {
    enabled,
    active: enabled ? resolveMuseHarnessId(bot.museHarness, env) : null,
    harnesses: listNovaHarnesses(env),
    runnerLocation: enabled ? resolveMuseRunnerLocation(bot.museRunnerLocation) : null,
  };
}

export async function getEngineInfo(
  deps: EngineInfoDeps,
  actor: Actor,
  botId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EngineInfo> {
  const bot = await requireOwnBot(deps, actor, botId);
  return buildEngineInfo(bot, env);
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
    select: { museHarness: true, museRunnerLocation: true },
  });
  return buildEngineInfo(bot, env);
}

export async function setEngineRunnerLocation(
  deps: EngineInfoDeps,
  actor: Actor,
  input: { botId: string; runnerLocation: NovaRunnerLocationId },
  env: NodeJS.ProcessEnv = process.env,
): Promise<EngineInfo> {
  if (env.NOVA_ENGINE !== "omnigent") {
    throw new ORPCError("BAD_REQUEST", {
      message: "Nova is not running on the Omnigent engine",
    });
  }
  await requireOwnBot(deps, actor, input.botId);

  const bot = await deps.prisma.bot.update({
    where: { id: input.botId },
    data: { museRunnerLocation: input.runnerLocation },
    select: { museHarness: true, museRunnerLocation: true },
  });
  return buildEngineInfo(bot, env);
}
