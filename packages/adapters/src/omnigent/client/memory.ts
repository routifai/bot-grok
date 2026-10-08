import type { OmnigentClientConfig } from "./core.js";
import { omnigentHeaders, throwOnError } from "./core.js";

export async function getOmnigentMemoryProfile(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
): Promise<{ profile: string | null }> {
  const response = await fetch(
    new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/memory/profile`, config.baseUrl),
    { headers: omnigentHeaders(config, email) },
  );
  await throwOnError(response, "get memory profile", config.secrets);
  const body = (await response.json()) as { profile?: string | null };
  return { profile: body.profile || null };
}

/** A memory claim as the engine serves it (`memory/service.py` `_claim_to_dict`). */
export interface OmnigentMemoryClaim {
  claim_id: string;
  kind: string;
  text: string;
  origin: "said" | "edited" | "noticed";
  person_authored: boolean;
  last_confirmed: number;
  /** Derived by the engine: an active claim past its `valid_until` reads as `expired`. */
  status: "active" | "expired";
}

/** `GET .../memory/claims` — every active claim, newest first. */
export async function listOmnigentMemoryClaims(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
): Promise<OmnigentMemoryClaim[]> {
  const response = await fetch(
    new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/memory/claims`, config.baseUrl),
    { headers: omnigentHeaders(config, email) },
  );
  await throwOnError(response, "list memory claims", config.secrets);
  const body = (await response.json()) as { claims?: OmnigentMemoryClaim[] };
  return body.claims ?? [];
}

/** `PATCH .../memory/claims/{id}` — the person's edit; the claim becomes person-authored. */
export async function patchOmnigentMemoryClaim(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
  claimId: string,
  text: string,
): Promise<OmnigentMemoryClaim> {
  const response = await fetch(
    new URL(
      `/v1/sessions/${encodeURIComponent(sessionId)}/memory/claims/${encodeURIComponent(claimId)}`,
      config.baseUrl,
    ),
    { method: "PATCH", headers: omnigentHeaders(config, email), body: JSON.stringify({ text }) },
  );
  await throwOnError(response, "edit memory claim", config.secrets);
  return (await response.json()) as OmnigentMemoryClaim;
}

/** `POST .../memory/forget` with `confirm` — the person deletes one claim. */
export async function forgetOmnigentMemoryClaim(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
  claimId: string,
): Promise<void> {
  const response = await fetch(
    new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/memory/forget`, config.baseUrl),
    {
      method: "POST",
      headers: omnigentHeaders(config, email),
      body: JSON.stringify({ claim_id: claimId, confirm: true }),
    },
  );
  await throwOnError(response, "forget memory claim", config.secrets);
}

/** A daily note as the engine serves it (`routes/daily_notes.py` `note_to_response`). */
export interface OmnigentDailyNote {
  date: string;
  sections: Record<string, string>;
  edited_by_person: boolean;
  finalized: boolean;
  updated_at: number;
}

/** `GET /v1/me/daily-notes` — the person's notes, newest first. */
export async function listOmnigentDailyNotes(
  config: OmnigentClientConfig,
  email: string,
  limit = 14,
): Promise<OmnigentDailyNote[]> {
  const url = new URL("/v1/me/daily-notes", config.baseUrl);
  url.searchParams.set("limit", String(limit));
  const response = await fetch(url, { headers: omnigentHeaders(config, email) });
  await throwOnError(response, "list daily notes", config.secrets);
  const body = (await response.json()) as { daily_notes?: OmnigentDailyNote[] };
  return body.daily_notes ?? [];
}

/** `PUT /v1/me/daily-notes/{date}` — the person's edit; the engine then never rewrites it. */
export async function putOmnigentDailyNote(
  config: OmnigentClientConfig,
  email: string,
  date: string,
  sections: Record<string, string>,
): Promise<OmnigentDailyNote> {
  const response = await fetch(
    new URL(`/v1/me/daily-notes/${encodeURIComponent(date)}`, config.baseUrl),
    {
      method: "PUT",
      headers: omnigentHeaders(config, email),
      body: JSON.stringify({ sections }),
    },
  );
  await throwOnError(response, "save daily note", config.secrets);
  return (await response.json()) as OmnigentDailyNote;
}
