// Real `memory.*` handlers: the Muse's Memory Profile and the person's editable memory claims,
// read from the same Super Chat as the Activity panel.
import {
  forgetOmnigentMemoryClaim,
  getOmnigentMemoryProfile,
  listOmnigentMemoryClaims,
  type OmnigentMemoryClaim,
  patchOmnigentMemoryClaim,
  redactMemoryProfile,
} from "@nova/adapters";
import type { Actor } from "@nova/contracts";
import { onSuperChat } from "../../omnigent-errors.js";
import { requireClient, requireSuperChat, type SuperChatDeps } from "../../super-chat-session.js";

/** `memory.profile`: the Muse's Memory Profile, read from the same Super Chat. */
export async function getMemoryProfile(
  deps: SuperChatDeps,
  actor: Actor,
  input: { botId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ profile: string | null }> {
  const client = requireClient(env, actor);
  const { superSessionId, email } = await requireSuperChat(deps, actor, input.botId);
  const result = await onSuperChat(getOmnigentMemoryProfile(client, email, superSessionId));
  return { profile: redactMemoryProfile(result.profile, client.secrets ?? []) };
}

function mapClaim(claim: OmnigentMemoryClaim, secrets: string[]) {
  return {
    id: claim.claim_id,
    kind: claim.kind,
    text: redactMemoryProfile(claim.text, secrets) ?? "",
    origin: claim.origin,
    personAuthored: claim.person_authored,
    date: claim.last_confirmed,
    expired: claim.status === "expired",
  };
}

/** `memory.claims`: the person's active memory claims, for the editable sections. */
export async function listMemoryClaims(
  deps: SuperChatDeps,
  actor: Actor,
  input: { botId: string },
  env: NodeJS.ProcessEnv = process.env,
) {
  const client = requireClient(env, actor);
  const { superSessionId, email } = await requireSuperChat(deps, actor, input.botId);
  const claims = await onSuperChat(listOmnigentMemoryClaims(client, email, superSessionId));
  return { claims: claims.map((claim) => mapClaim(claim, client.secrets ?? [])) };
}

/** `memory.editClaim`: the person's text edit of one claim. */
export async function editMemoryClaim(
  deps: SuperChatDeps,
  actor: Actor,
  input: { botId: string; claimId: string; text: string },
  env: NodeJS.ProcessEnv = process.env,
) {
  const client = requireClient(env, actor);
  const { superSessionId, email } = await requireSuperChat(deps, actor, input.botId);
  const claim = await onSuperChat(
    patchOmnigentMemoryClaim(client, email, superSessionId, input.claimId, input.text),
  );
  return mapClaim(claim, client.secrets ?? []);
}

/** `memory.forgetClaim`: the person deletes one claim. */
export async function forgetMemoryClaim(
  deps: SuperChatDeps,
  actor: Actor,
  input: { botId: string; claimId: string },
  env: NodeJS.ProcessEnv = process.env,
) {
  const client = requireClient(env, actor);
  const { superSessionId, email } = await requireSuperChat(deps, actor, input.botId);
  await onSuperChat(forgetOmnigentMemoryClaim(client, email, superSessionId, input.claimId));
  return { ok: true as const };
}
