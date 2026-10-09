import type { OmnigentClientConfig } from "./client/core.js";
import { omnigentHeaders, throwOnError } from "./client/core.js";

/** A suggestion (an Idea) recorded by a background run
 * (engine/omnigent/omnigent/server/routes/suggestions.py `suggestion_to_response`). */
export interface OmnigentSuggestion {
  id: string;
  parent_session_id: string;
  title: string;
  why: string;
  /** The exact message to send to the Conversation if the person accepts it. */
  message: string;
  status: "open" | "done" | "dismissed";
  source_session_id: string | null;
  created_at: number;
  updated_at: number | null;
}

/** `GET /v1/suggestions?parent_session_id=&status=open` — newest first. */
export async function listOmnigentSuggestions(
  config: OmnigentClientConfig,
  email: string,
  parentSessionId: string,
  status: OmnigentSuggestion["status"] = "open",
): Promise<OmnigentSuggestion[]> {
  const url = new URL("/v1/suggestions", config.baseUrl);
  url.searchParams.set("parent_session_id", parentSessionId);
  url.searchParams.set("status", status);
  const response = await fetch(url, { headers: omnigentHeaders(config, email) });
  await throwOnError(response, "list suggestions", config.secrets);
  const body = (await response.json()) as { suggestions?: OmnigentSuggestion[] };
  return body.suggestions ?? [];
}

/** `PATCH /v1/suggestions/{id}` — mark it done (accepted) or dismissed. */
export async function patchOmnigentSuggestion(
  config: OmnigentClientConfig,
  email: string,
  id: string,
  status: OmnigentSuggestion["status"],
): Promise<OmnigentSuggestion> {
  const response = await fetch(
    new URL(`/v1/suggestions/${encodeURIComponent(id)}`, config.baseUrl),
    {
      method: "PATCH",
      headers: omnigentHeaders(config, email),
      body: JSON.stringify({ status }),
    },
  );
  await throwOnError(response, "update suggestion", config.secrets);
  return (await response.json()) as OmnigentSuggestion;
}
