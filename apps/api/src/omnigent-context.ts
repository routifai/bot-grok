// Omnigent's per-turn context-provider hook (docs/omnigent-spike.md): a plain, unauthenticated
// (by user session) Hono route Omnigent calls on every turn to fetch Nova's instructions for
// <deployment_context>. Not an oRPC route — Omnigent is not a Nova user and carries no session.

import { composeOmnigentContext, type OmnigentContextDeps } from "@aiden/adapters";
import { hasValidBearerToken } from "@aiden/core";
import type { Hono } from "hono";
import { readBoundedBody } from "./http-body.js";

export const OMNIGENT_CONTEXT_PATH = "/internal/omnigent/context";

/** The request body is small (labels + one turn's text); this is a generous ceiling. */
const MAX_BODY_BYTES = 64 * 1024;

/** The endpoint's 2s SLA (docs/omnigent-spike.md); always answer by then, even on a slow DB. */
const RESPOND_BY_MS = 1_800;

export interface OmnigentContextRouteDeps extends OmnigentContextDeps {
  /** env OMNIGENT_CONTEXT_PROVIDER_SECRET; the route 404s entirely when unset. */
  contextProviderSecret: string | undefined;
}

interface OmnigentContextRequest {
  labels: Record<string, string>;
  turn_input: string;
}

function parseRequestBody(raw: string): OmnigentContextRequest | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const rawLabels = record.labels;
  const labels: Record<string, string> = {};
  if (rawLabels && typeof rawLabels === "object") {
    for (const [key, value] of Object.entries(rawLabels as Record<string, unknown>)) {
      if (typeof value === "string") labels[key] = value;
    }
  }
  const turnInput = typeof record.turn_input === "string" ? record.turn_input : "";
  return { labels, turn_input: turnInput };
}

export function mountOmnigentContextRoute(app: Hono, deps: OmnigentContextRouteDeps): void {
  app.post(OMNIGENT_CONTEXT_PATH, async (c) => {
    // The endpoint does not exist for a deployment that has not opted into the spike.
    if (!deps.contextProviderSecret) return c.notFound();
    if (!hasValidBearerToken(c.req.header("authorization"), deps.contextProviderSecret)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const raw = await readBoundedBody(c.req.raw, MAX_BODY_BYTES);
    if (raw === null) return c.json({ error: "Payload too large" }, 413);
    const parsed = raw ? parseRequestBody(raw) : null;
    if (!parsed) return c.json({ instructions: "" });

    // Never let a slow compose (or an unexpected error) blow Omnigent's 2s deadline.
    const instructions = await Promise.race([
      composeOmnigentContext(deps, { labels: parsed.labels, turnInput: parsed.turn_input }).catch(
        () => "",
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), RESPOND_BY_MS)),
    ]);
    return c.json({ instructions });
  });
}
