import type { OmnigentClientConfig } from "./core.js";
import { omnigentHeaders, throwOnError } from "./core.js";

/** `PUT /v1/me/proactivity` — the engine accepts a partial body and keeps omitted fields, so
 * sending only `timezone` leaves the person's proactivity and quiet hours alone. */
export async function putOmnigentTimezone(
  config: OmnigentClientConfig,
  email: string,
  timezone: string,
): Promise<void> {
  const response = await fetch(new URL("/v1/me/proactivity", config.baseUrl), {
    method: "PUT",
    headers: omnigentHeaders(config, email),
    body: JSON.stringify({ timezone }),
  });
  await throwOnError(response, "set timezone", config.secrets);
}

/** `PUT /v1/me/proactivity` — the level and quiet hours (`null` clears them); the timezone is kept. */
export async function putOmnigentProactivity(
  config: OmnigentClientConfig,
  email: string,
  prefs: {
    proactivity: "off" | "low" | "normal";
    quietStart: string | null;
    quietEnd: string | null;
  },
): Promise<void> {
  const response = await fetch(new URL("/v1/me/proactivity", config.baseUrl), {
    method: "PUT",
    headers: omnigentHeaders(config, email),
    body: JSON.stringify({
      proactivity: prefs.proactivity,
      quiet_start: prefs.quietStart,
      quiet_end: prefs.quietEnd,
    }),
  });
  await throwOnError(response, "set proactivity", config.secrets);
}
