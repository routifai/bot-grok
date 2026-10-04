// Adapted from OpenMuse (MIT) — openmuse/server/service.py
//
// How eagerly the Muse works on Goals on its own (CONTEXT.md, "Proactivity") and the quiet-hours
// window that pauses it, as stored on the Bot row. The engine applies both
// (docs/adr/0005-proactive-work-is-scheduled-helper-runs.md); Nova only stores and shows them.

import {
  DEFAULT_MUSE_SETTINGS,
  type MuseSettings,
  PROACTIVITY_LEVELS,
  type Proactivity,
} from "@aiden/contracts";

/** The Bot columns `MuseSettings` is stored in (apps/api/src/muse-settings.ts, B7). */
export interface MuseSettingsRow {
  museProactivity: string | null;
  museQuietHours: string | null;
}

/**
 * `MuseSettingsRow` -> `MuseSettings`, applying the stored defaults: `museProactivity` NULL
 * means `DEFAULT_MUSE_SETTINGS.proactivity`; `museQuietHours` NULL means
 * `DEFAULT_MUSE_SETTINGS.quietHours`, while `""` is the explicit "quiet hours off" (`null`
 * in the contract) so it round-trips distinctly from "never set".
 */
export function resolveMuseSettings(row: MuseSettingsRow): MuseSettings {
  const proactivity = isProactivity(row.museProactivity)
    ? row.museProactivity
    : DEFAULT_MUSE_SETTINGS.proactivity;
  const quietHours =
    row.museQuietHours === null
      ? DEFAULT_MUSE_SETTINGS.quietHours
      : row.museQuietHours === ""
        ? null
        : row.museQuietHours;
  return { proactivity, quietHours };
}

function isProactivity(value: string | null): value is Proactivity {
  return value !== null && (PROACTIVITY_LEVELS as readonly string[]).includes(value);
}
