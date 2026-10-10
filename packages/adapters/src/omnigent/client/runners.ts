// Where and on what a session runs: the built-in agent bundles (`GET /v1/agents`), the hosts a
// person has registered (`GET /v1/hosts`), and the two calls the engine's own web UI makes to move
// a session onto another host (engine/omnigent/web/src/shell/SwitchHostDialog.tsx).
import type { OmnigentClientConfig } from "./core.js";
import { omnigentHeaders, throwOnError } from "./core.js";

/** A built-in agent bundle, as `GET /v1/agents` lists it. */
export interface OmnigentAgent {
  id: string;
  name: string;
  /** The harness its spec runs, e.g. `claude-sdk` or `pi`; `null` when the bundle didn't load. */
  harness: string | null;
  builtin?: boolean;
}

/** `GET /v1/agents` — every built-in agent bundle (one page of up to 200). */
export async function listOmnigentAgents(
  config: OmnigentClientConfig,
  email: string,
): Promise<OmnigentAgent[]> {
  const url = new URL("/v1/agents", config.baseUrl);
  url.searchParams.set("limit", "200");
  url.searchParams.set("order", "asc");
  const response = await fetch(url, { headers: omnigentHeaders(config, email) });
  await throwOnError(response, "list agents", config.secrets);
  return ((await response.json()) as { data: OmnigentAgent[] }).data;
}

/** A host the caller owns, as `GET /v1/hosts` lists it. */
export interface OmnigentHost {
  host_id: string;
  name: string;
  status: "online" | "offline";
  /** Set for a server-managed sandbox host (e.g. `computer`, `docker`); `null` for a machine the
   * person connected with `omni host`. */
  sandbox_provider: string | null;
}

/** `GET /v1/hosts` — the caller's hosts, online and offline. */
export async function listOmnigentHosts(
  config: OmnigentClientConfig,
  email: string,
): Promise<OmnigentHost[]> {
  const response = await fetch(new URL("/v1/hosts", config.baseUrl), {
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "list hosts", config.secrets);
  return ((await response.json()) as { hosts: OmnigentHost[] }).hosts;
}

/** The part of `GET /v1/info` that says how a person signs in to the engine. */
export interface OmnigentServerInfo {
  accounts_enabled?: boolean;
  login_url?: string | null;
}

/** `GET /v1/info` — public server capabilities. */
export async function getOmnigentServerInfo(
  config: OmnigentClientConfig,
  email: string,
): Promise<OmnigentServerInfo> {
  const response = await fetch(new URL("/v1/info", config.baseUrl), {
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "server info", config.secrets);
  return (await response.json()) as OmnigentServerInfo;
}

/** The host's home directory: the parent of the first entry `GET /v1/hosts/{id}/filesystem`
 * lists (the engine expands `~` on the host). `null` when the home is empty. */
export async function getOmnigentHostHome(
  config: OmnigentClientConfig,
  email: string,
  hostId: string,
): Promise<string | null> {
  const url = new URL(`/v1/hosts/${encodeURIComponent(hostId)}/filesystem`, config.baseUrl);
  url.searchParams.set("limit", "1");
  const response = await fetch(url, { headers: omnigentHeaders(config, email) });
  await throwOnError(response, "list host home", config.secrets);
  const first = ((await response.json()) as { data?: { path?: string }[] }).data?.[0]?.path;
  if (!first) return null;
  const cut = first.replace(/[\\/]+$/, "").search(/[\\/][^\\/]*$/);
  return cut > 0 ? first.slice(0, cut) : null;
}

/**
 * Moves a session onto `hostId`, the engine's own two-step switch: `PATCH /v1/sessions/{id}`
 * releases the current runner (and the model override, which belongs to the old host's catalog;
 * `silent` keeps it off the transcript), then `POST /v1/hosts/{id}/runners` binds a runner there
 * in `workspace` and repoints the session's host. Between the two the session has no runner;
 * calling this again (to either host) recovers it.
 */
export async function moveOmnigentSessionToHost(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
  hostId: string,
  workspace: string,
): Promise<{ runner_id: string }> {
  const release = await fetch(
    new URL(`/v1/sessions/${encodeURIComponent(sessionId)}`, config.baseUrl),
    {
      method: "PATCH",
      headers: omnigentHeaders(config, email),
      body: JSON.stringify({ runner_id: "", model_override: "default", silent: true }),
    },
  );
  await throwOnError(release, "release runner", config.secrets);
  const launch = await fetch(
    new URL(`/v1/hosts/${encodeURIComponent(hostId)}/runners`, config.baseUrl),
    {
      method: "POST",
      headers: omnigentHeaders(config, email),
      body: JSON.stringify({ session_id: sessionId, workspace }),
    },
  );
  await throwOnError(launch, "launch runner", config.secrets);
  return (await launch.json()) as { runner_id: string };
}
