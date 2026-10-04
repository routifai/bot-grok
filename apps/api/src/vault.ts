// The secrets vault (engine `/v1/me/vault`, docs/muse): Nova relays the secure-entry form's submit
// and the Settings list. A value passes through `save` once, goes straight to the engine and is
// never stored, returned or logged here.
import {
  deleteOmnigentVaultEntry,
  getOmnigentVaultRequest,
  listOmnigentVault,
  type OmnigentClientConfig,
  type OmnigentVaultEntry,
  omnigentClientConfigFromEnv,
  saveOmnigentVaultEntry,
} from "@aiden/adapters";
import type { Actor } from "@aiden/contracts";
import type { PrismaClient } from "@aiden/db";
import { ORPCError } from "@orpc/server";

export interface VaultDeps {
  prisma: PrismaClient;
}

async function resolve(deps: VaultDeps, actor: Actor, botId: string, env: NodeJS.ProcessEnv) {
  const client: OmnigentClientConfig | undefined = omnigentClientConfigFromEnv(env);
  if (!client) throw new ORPCError("BAD_REQUEST", { message: "The vault is not available." });
  const [bot, user] = await Promise.all([
    deps.prisma.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
      select: { id: true },
    }),
    deps.prisma.user.findUnique({ where: { id: actor.userId }, select: { email: true } }),
  ]);
  if (!bot || !user) throw new ORPCError("NOT_FOUND", { message: "Muse not found" });
  return { client, email: user.email };
}

const iso = (seconds: number | null) =>
  seconds == null ? null : new Date(seconds * 1000).toISOString();

export function mapVaultEntry(entry: OmnigentVaultEntry) {
  return {
    id: entry.id,
    name: entry.name,
    site: entry.site,
    username: entry.username,
    createdAt: iso(entry.created_at) ?? new Date(0).toISOString(),
    lastUsedAt: iso(entry.last_used_at),
  };
}

export async function listVault(
  deps: VaultDeps,
  actor: Actor,
  input: { botId: string },
  env: NodeJS.ProcessEnv = process.env,
) {
  const { client, email } = await resolve(deps, actor, input.botId, env);
  return { entries: (await listOmnigentVault(client, email)).map(mapVaultEntry) };
}

export async function removeVaultEntry(
  deps: VaultDeps,
  actor: Actor,
  input: { botId: string; id: string },
  env: NodeJS.ProcessEnv = process.env,
) {
  const { client, email } = await resolve(deps, actor, input.botId, env);
  await deleteOmnigentVaultEntry(client, email, input.id);
  return { ok: true as const };
}

export async function getVaultRequest(
  deps: VaultDeps,
  actor: Actor,
  input: { botId: string; requestId: string },
  env: NodeJS.ProcessEnv = process.env,
) {
  const { client, email } = await resolve(deps, actor, input.botId, env);
  const request = await getOmnigentVaultRequest(client, email, input.requestId);
  return {
    id: request.id,
    name: request.name,
    site: request.site,
    reason: request.reason,
    status: request.status,
  };
}

export async function saveVaultEntry(
  deps: VaultDeps,
  actor: Actor,
  input: {
    botId: string;
    requestId?: string | undefined;
    name: string;
    site: string;
    username?: string | undefined;
    password: string;
  },
  env: NodeJS.ProcessEnv = process.env,
) {
  const { client, email } = await resolve(deps, actor, input.botId, env);
  const entry = await saveOmnigentVaultEntry(client, email, {
    name: input.name,
    site: input.site,
    password: input.password,
    ...(input.username ? { username: input.username } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
  });
  return mapVaultEntry(entry);
}
