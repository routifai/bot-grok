// External-effect bookkeeping: recording an at-most-once tool effect (with legacy key
// reconciliation), completing it, and the sandbox command runner mutating tool handlers use.
import type { ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { sandboxCommandTimeoutMs } from "@rakazo/core";
import {
  isToolEffectIdempotencyKey,
  legacyScopedToolEffectIdempotencyKey,
  stableJsonValue,
} from "@rakazo/core/node/approval-effect-key";
import { completeExternalEffect } from "../approval-effect.js";
import type { ExecutorDeps } from "./types.js";

export async function recordEffect(
  deps: ExecutorDeps,
  run: { id: string; spaceId: string; threadId: string; botId: string },
  kind: string,
  idempotencyKey: string,
  request: unknown,
  legacyIdempotencyKey?: string,
  consumedIds?: Set<string>,
) {
  const existing = await deps.prisma.externalEffect.findUnique({
    where: { idempotencyKey },
  });
  if (existing) {
    consumedIds?.add(existing.id);
    await deps.events.append({
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      type: "effect.reconciled",
      runId: run.id,
      payload: { executionId: idempotencyKey, kind },
    });
    return { duplicate: true, effect: existing };
  }

  // Pre-fix rows used bare provider ids or scoped keys that included the
  // ephemeral model tool-call id. Same-id unique lookup still works; a restart
  // with a new id finds the row by run, tool, and request instead.
  let expectedRequest: string | undefined;
  try {
    expectedRequest = stableJsonValue(request);
  } catch {
    expectedRequest = undefined;
  }
  if (legacyIdempotencyKey && legacyIdempotencyKey !== idempotencyKey && expectedRequest) {
    const scopedLegacy =
      request && typeof request === "object" && !Array.isArray(request)
        ? legacyScopedToolEffectIdempotencyKey(
            run.id,
            kind,
            legacyIdempotencyKey,
            request as Record<string, unknown>,
          )
        : undefined;
    for (const candidate of [scopedLegacy, legacyIdempotencyKey]) {
      if (!candidate || candidate === idempotencyKey) continue;
      const sameIdLegacy = await deps.prisma.externalEffect.findUnique({
        where: { idempotencyKey: candidate },
      });
      if (
        sameIdLegacy &&
        !consumedIds?.has(sameIdLegacy.id) &&
        sameIdLegacy.runId === run.id &&
        sameIdLegacy.kind === kind &&
        stableJsonValue(sameIdLegacy.request) === expectedRequest
      ) {
        consumedIds?.add(sameIdLegacy.id);
        await deps.events.append({
          spaceId: run.spaceId,
          threadId: run.threadId,
          botId: run.botId,
          type: "effect.reconciled",
          runId: run.id,
          payload: { executionId: candidate, kind, legacy: true },
        });
        return { duplicate: true, effect: sameIdLegacy };
      }
    }
  }

  const prior = await deps.prisma.externalEffect.findMany({
    where: { runId: run.id, kind },
    orderBy: { createdAt: "asc" },
  });
  const legacy =
    expectedRequest === undefined
      ? undefined
      : prior.find((candidate) => {
          if (consumedIds?.has(candidate.id)) return false;
          if (candidate.idempotencyKey === idempotencyKey) return false;
          if (candidate.runId !== run.id || candidate.kind !== kind) return false;
          try {
            if (stableJsonValue(candidate.request) !== expectedRequest) return false;
          } catch {
            return false;
          }
          // Live later occurrences use a new modern key; do not steal an earlier modern row.
          return !isToolEffectIdempotencyKey(candidate.idempotencyKey, run.id, kind);
        });
  if (legacy) {
    consumedIds?.add(legacy.id);
    await deps.events.append({
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      type: "effect.reconciled",
      runId: run.id,
      payload: { executionId: legacy.idempotencyKey, kind, legacy: true },
    });
    return { duplicate: true, effect: legacy };
  }

  const effect = await deps.prisma.externalEffect.create({
    data: {
      spaceId: run.spaceId,
      runId: run.id,
      kind,
      idempotencyKey,
      status: "intended",
      request: request as never,
    },
  });
  consumedIds?.add(effect.id);
  return { duplicate: false, effect };
}

export async function completeEffect(
  deps: ExecutorDeps,
  effectId: string,
  expectedStatus: "intended" | "executing",
  result: unknown,
) {
  const storedResult =
    result &&
    typeof result === "object" &&
    (result as { kind?: unknown }).kind === "agent_tool_result" &&
    "details" in result
      ? (result as { details: unknown }).details
      : result;
  return completeExternalEffect(deps.prisma, effectId, expectedStatus, storedResult as never);
}

export function uncertainEffectError(toolName: string): Error {
  return new Error(
    `tool ${toolName} has an earlier execution with an uncertain outcome; it may already have completed, so verify the destination before retrying`,
  );
}

export async function runSandboxCommand(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  argv: string[],
  cwd: string | undefined,
  env: Record<string, string>,
  context: {
    operationId: string;
    traceId: string;
    spaceId: string;
    userId: string;
    botId?: string;
    runId?: string;
    signal: AbortSignal;
  },
) {
  let stdout = "";
  let stderr = "";
  let code = 0;
  for await (const event of sandbox.execute(
    computer,
    {
      argv,
      cwd,
      env: Object.keys(env).length > 0 ? env : undefined,
      timeoutMs: sandboxCommandTimeoutMs(),
    },
    context,
  )) {
    if (event.type === "stdout") stdout += event.data;
    if (event.type === "stderr") stderr += event.data;
    if (event.type === "exit") code = event.code;
  }
  return { stdout, stderr, code };
}
