import type { OmnigentClientConfig } from "./core.js";
import { omnigentHeaders, throwOnError } from "./core.js";

export interface OmnigentComputerState {
  available: boolean;
  in_control: boolean;
  /** The session's runner is connected; absent on engines that predate it. */
  ready?: boolean;
}

export interface OmnigentComputerScreen {
  /** The supervisor's noVNC URL incl. token — reachable from Nova's API host, not the browser. */
  screen_url: string;
  in_control: boolean;
}

export function computerUrl(config: OmnigentClientConfig, sessionId: string, tail = ""): URL {
  return new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/computer${tail}`, config.baseUrl);
}

/** `GET /v1/sessions/{id}/computer` — whether the session has a Computer and who controls it
 * (engine/omnigent/omnigent/server/routes/sessions/routes_computer.py). */
export async function getOmnigentComputer(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
): Promise<OmnigentComputerState> {
  const response = await fetch(computerUrl(config, sessionId), {
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "get computer", config.secrets);
  return (await response.json()) as OmnigentComputerState;
}

/** `POST /v1/sessions/{id}/computer/screen` — `interactive: true` is Take over. */
export async function openOmnigentComputerScreen(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
  interactive: boolean,
): Promise<OmnigentComputerScreen> {
  const response = await fetch(computerUrl(config, sessionId, "/screen"), {
    method: "POST",
    headers: omnigentHeaders(config, email),
    body: JSON.stringify({ interactive }),
  });
  await throwOnError(response, "open computer screen", config.secrets);
  return (await response.json()) as OmnigentComputerScreen;
}

/** `POST /v1/sessions/{id}/computer/release` — hand control back to the Muse. */
export async function releaseOmnigentComputer(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
): Promise<OmnigentComputerScreen> {
  const response = await fetch(computerUrl(config, sessionId, "/release"), {
    method: "POST",
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "release computer", config.secrets);
  return (await response.json()) as OmnigentComputerScreen;
}
