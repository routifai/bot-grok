import type { OmnigentClientConfig } from "./core.js";
import { omnigentHeaders, throwOnError } from "./core.js";

/** One decision waiting on the person (`GET /v1/me/asks`). Wording is the client's: `kind` and
 * the choice ids are stable codes. */
export type OmnigentAsk =
  | (OmnigentAskBase & {
      kind: "approval";
      subject: {
        summary: string;
        can_always: boolean;
        always_label: string | null;
        [key: string]: unknown;
      };
    })
  | (OmnigentAskBase & {
      kind: "plan_proposal";
      subject: {
        objective_title: string;
        reason: string;
        is_first_plan: boolean;
        plan: Array<{ id: string | null; title: string }>;
      };
    })
  | (OmnigentAskBase & {
      kind: "blocked_task";
      subject: { objective_title: string; task_id: string; title: string; note: string | null };
    });

interface OmnigentAskBase {
  /** `approval:<id>`, `proposal:<objective>:<id>` or `task:<objective>:<id>`. */
  id: string;
  session_id: string;
  objective_id: string | null;
  /** Epoch seconds. */
  created_at: number;
  choices: Array<{ id: string; style: "primary" | "secondary" | "danger" }>;
}

/** `GET /v1/me/asks` — everything waiting on the caller, newest first. */
export async function listOmnigentAsks(
  config: OmnigentClientConfig,
  email: string,
): Promise<OmnigentAsk[]> {
  const response = await fetch(new URL("/v1/me/asks", config.baseUrl), {
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "list asks", config.secrets);
  return ((await response.json()) as { data: OmnigentAsk[] }).data;
}

/** `POST /v1/me/asks/{id}/answer` — `choice` is one of the ask's choice ids; a blocked task's
 * `answer` needs the person's reply as `note`. */
export async function answerOmnigentAsk(
  config: OmnigentClientConfig,
  email: string,
  askId: string,
  answer: { choice: string; note?: string },
): Promise<void> {
  const response = await fetch(
    new URL(`/v1/me/asks/${encodeURIComponent(askId)}/answer`, config.baseUrl),
    {
      method: "POST",
      headers: omnigentHeaders(config, email),
      body: JSON.stringify(answer),
    },
  );
  await throwOnError(response, "answer ask", config.secrets);
}
