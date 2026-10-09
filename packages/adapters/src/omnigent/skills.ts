import type { OmnigentClientConfig } from "./client/core.js";
import { omnigentHeaders, throwOnError } from "./client/core.js";
import { computerUrl } from "./computer.js";

/** A taught skill's document (engine/omnigent/omnigent/superchat/taught_skills.py). */
export interface OmnigentSkillDoc {
  name: string;
  goal: string;
  preconditions: string[];
  inputs: { name: string; label: string; default: string; description?: string }[];
  steps: {
    intent: string;
    check: string;
    approval: boolean;
    keyframe: string | null;
    hint?: { role?: string; name?: string; selector?: string; url?: string };
  }[];
  returns: string;
}

/** A skill taught by demonstration (routes/taught_skills.py `skill_to_response`). */
export interface OmnigentTaughtSkill {
  id: string;
  parent_session_id: string;
  recording_id: string | null;
  name: string;
  goal: string;
  status: "recording" | "drafting" | "draft" | "saved" | "failed";
  version: number;
  doc: OmnigentSkillDoc | null;
  created_at: number;
  updated_at: number | null;
  stopped_at: number | null;
  /** Only on a single-skill read. */
  keyframes?: string[];
}

function taughtSkillUrl(config: OmnigentClientConfig, id: string, tail = ""): URL {
  return new URL(`/v1/taught-skills/${encodeURIComponent(id)}${tail}`, config.baseUrl);
}

/** `POST /v1/sessions/{id}/computer/recording` `{action: "start"}`. */
export async function startOmnigentRecording(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
  goal: string,
): Promise<{ recording_id: string; skill_id: string }> {
  const response = await fetch(computerUrl(config, sessionId, "/recording"), {
    method: "POST",
    headers: omnigentHeaders(config, email),
    body: JSON.stringify({ action: "start", goal }),
  });
  await throwOnError(response, "start recording", config.secrets);
  return (await response.json()) as { recording_id: string; skill_id: string };
}

/** `POST /v1/sessions/{id}/computer/recording` `{action: "stop"}` — the skill is then drafted. */
export async function stopOmnigentRecording(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
): Promise<{ recording_id: string; skill_id: string }> {
  const response = await fetch(computerUrl(config, sessionId, "/recording"), {
    method: "POST",
    headers: omnigentHeaders(config, email),
    body: JSON.stringify({ action: "stop" }),
  });
  await throwOnError(response, "stop recording", config.secrets);
  return (await response.json()) as { recording_id: string; skill_id: string };
}

/** `GET /v1/taught-skills?parent_session_id=` — newest first. */
export async function listOmnigentTaughtSkills(
  config: OmnigentClientConfig,
  email: string,
  parentSessionId: string,
): Promise<OmnigentTaughtSkill[]> {
  const url = new URL("/v1/taught-skills", config.baseUrl);
  url.searchParams.set("parent_session_id", parentSessionId);
  const response = await fetch(url, { headers: omnigentHeaders(config, email) });
  await throwOnError(response, "list taught skills", config.secrets);
  const body = (await response.json()) as { skills?: OmnigentTaughtSkill[] };
  return body.skills ?? [];
}

export async function getOmnigentTaughtSkill(
  config: OmnigentClientConfig,
  email: string,
  id: string,
): Promise<OmnigentTaughtSkill> {
  const response = await fetch(taughtSkillUrl(config, id), {
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "get taught skill", config.secrets);
  return (await response.json()) as OmnigentTaughtSkill;
}

/** One keyframe of a skill's recording as a `data:` URI, or `null` when it is gone. */
export async function getOmnigentSkillKeyframe(
  config: OmnigentClientConfig,
  email: string,
  id: string,
  name: string,
): Promise<string | null> {
  const response = await fetch(
    taughtSkillUrl(config, id, `/keyframes/${encodeURIComponent(name)}`),
    {
      headers: omnigentHeaders(config, email),
    },
  );
  if (response.status === 404) return null;
  await throwOnError(response, "get keyframe", config.secrets);
  const bytes = Buffer.from(await response.arrayBuffer());
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

/** `PUT /v1/taught-skills/{id}/doc` — a new version of the document. */
export async function putOmnigentTaughtSkillDoc(
  config: OmnigentClientConfig,
  email: string,
  id: string,
  doc: OmnigentSkillDoc,
): Promise<OmnigentTaughtSkill> {
  const response = await fetch(taughtSkillUrl(config, id, "/doc"), {
    method: "PUT",
    headers: omnigentHeaders(config, email),
    body: JSON.stringify({ doc }),
  });
  await throwOnError(response, "save skill draft", config.secrets);
  return (await response.json()) as OmnigentTaughtSkill;
}

export async function saveOmnigentTaughtSkill(
  config: OmnigentClientConfig,
  email: string,
  id: string,
): Promise<OmnigentTaughtSkill> {
  const response = await fetch(taughtSkillUrl(config, id, "/save"), {
    method: "POST",
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "save skill", config.secrets);
  return (await response.json()) as OmnigentTaughtSkill;
}

/** `POST /v1/taught-skills/{id}/render` — the text a turn follows, with inputs filled in. */
export async function renderOmnigentTaughtSkill(
  config: OmnigentClientConfig,
  email: string,
  id: string,
  inputs: Record<string, string> = {},
): Promise<{ skill_id: string; name: string; text: string; missing_inputs: string[] }> {
  const response = await fetch(taughtSkillUrl(config, id, "/render"), {
    method: "POST",
    headers: omnigentHeaders(config, email),
    body: JSON.stringify({ inputs }),
  });
  await throwOnError(response, "render skill", config.secrets);
  return (await response.json()) as {
    skill_id: string;
    name: string;
    text: string;
    missing_inputs: string[];
  };
}

export async function deleteOmnigentTaughtSkill(
  config: OmnigentClientConfig,
  email: string,
  id: string,
): Promise<void> {
  const response = await fetch(taughtSkillUrl(config, id), {
    method: "DELETE",
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "delete taught skill", config.secrets);
}
