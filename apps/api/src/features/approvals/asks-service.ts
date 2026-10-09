import type { OmnigentClientConfig } from "@nova/adapters";
import type { Actor, Ask } from "@nova/contracts";
import type { PrismaClient } from "@nova/db";
import { ORPCError } from "@orpc/server";
import { requireEngine } from "../../engine-client.js";
import { engineAnswerAsk, engineListAsks, isEngineAskId } from "./asks.js";

// `asks.list` / `asks.count` / `asks.answer`. The Asks are the engine's decisions inbox
// (./asks.ts, ADR 0009); Nova keeps no Ask rows and has no path that serves them without the
// engine, so a missing engine is a clear error.

export interface AsksDeps {
  prisma: PrismaClient;
}

export async function listAsks(
  deps: AsksDeps,
  engine: OmnigentClientConfig | undefined,
  actor: Actor,
  botId: string,
): Promise<Ask[]> {
  return engineListAsks(deps, requireEngine(engine, "Asks"), actor, botId);
}

export async function countAsks(
  deps: AsksDeps,
  engine: OmnigentClientConfig | undefined,
  actor: Actor,
  botId: string,
): Promise<{ count: number }> {
  return { count: (await listAsks(deps, engine, actor, botId)).length };
}

export async function answerAsk(
  deps: AsksDeps,
  engine: OmnigentClientConfig | undefined,
  actor: Actor,
  input: { askId: string; answer: string },
): Promise<{ ok: true }> {
  const client = requireEngine(engine, "Asks");
  if (!isEngineAskId(input.askId)) {
    throw new ORPCError("BAD_REQUEST", { message: "This is not an Ask the engine is holding" });
  }
  return engineAnswerAsk(deps, client, actor, input);
}
