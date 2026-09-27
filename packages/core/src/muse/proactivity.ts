// Adapted from OpenMuse (MIT) — openmuse/server/service.py
//
// How eagerly the Muse works on Goals on its own (CONTEXT.md, "Proactivity"), and the
// quiet-hours window that pauses it. `Profile.interval_seconds` becomes
// `proactivityIntervalMs`, `Profile.in_quiet_hours` becomes `inQuietHours`, and
// `Profile.quiet_hours_end` becomes `quietHoursEnd`. Unlike OpenMuse (server local time),
// the quiet-hours window here is evaluated in the person's own IANA time zone.

import type { MuseSettings, Proactivity } from "@rakazo/contracts";

/** Local-time window with no background work, "HH:MM-HH:MM"; may wrap midnight. */
type QuietHours = string;

const HOUR_MS = 60 * 60_000;

/**
 * How often the Muse should work a Goal unprompted at each level, in milliseconds.
 * `off` never works on its own, so it returns `null`.
 */
export function proactivityIntervalMs(level: Proactivity): number | null {
  switch (level) {
    case "off":
      return null;
    case "low":
      return 4 * HOUR_MS;
    case "normal":
      return HOUR_MS;
    case "high":
      return 20 * 60_000;
  }
}

type QuietWindow = { startMinute: number; endMinute: number };

function parseQuietHours(window: QuietHours | null | undefined): QuietWindow | null {
  if (!window) return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(window);
  if (!match) return null;
  const startHour = match[1];
  const startMinute = match[2];
  const endHour = match[3];
  const endMinute = match[4];
  if (!startHour || !startMinute || !endHour || !endMinute) return null;
  const start = Number(startHour) * 60 + Number(startMinute);
  const end = Number(endHour) * 60 + Number(endMinute);
  if (start === end) return null; // a zero-width window would either never or always be quiet
  return { startMinute: start, endMinute: end };
}

/** `now`'s calendar date and minute-of-day as observed in `timeZone`, DST-safe via Intl. */
function zonedParts(now: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(now)) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** The offset (in minutes) to add to a UTC instant to get the wall-clock time in `timeZone`. */
function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const local = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  return (asUtc - instant.getTime()) / 60_000;
}

/**
 * The UTC instant of a calendar date + wall-clock time as observed in `timeZone`.
 * DST-safe: corrects the offset once against the initial guess, which resolves every
 * transition except the (here irrelevant) ambiguous/skipped minutes of the transition
 * hour itself.
 */
function zonedTimeToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset = zoneOffsetMinutes(new Date(guess), timeZone);
  let instant = guess - offset * 60_000;
  const offset2 = zoneOffsetMinutes(new Date(instant), timeZone);
  if (offset2 !== offset) instant = guess - offset2 * 60_000;
  return new Date(instant);
}

function addCalendarDays(year: number, month: number, day: number, days: number) {
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * 86_400_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** Whether `now` (in `timeZone`) falls inside the quiet-hours window; may wrap midnight. */
export function inQuietHours(
  window: QuietHours | null | undefined,
  now: Date,
  timeZone: string,
): boolean {
  const parsed = parseQuietHours(window);
  if (!parsed) return false;
  const local = zonedParts(now, timeZone);
  const minuteOfDay = local.hour * 60 + local.minute;
  const { startMinute, endMinute } = parsed;
  if (startMinute <= endMinute) return minuteOfDay >= startMinute && minuteOfDay < endMinute;
  return minuteOfDay >= startMinute || minuteOfDay < endMinute; // wraps midnight
}

/**
 * When the quiet-hours window that contains `now` ends, or `null` when `now` isn't in one.
 */
export function quietHoursEnd(
  window: QuietHours | null | undefined,
  now: Date,
  timeZone: string,
): Date | null {
  const parsed = parseQuietHours(window);
  if (!parsed || !inQuietHours(window, now, timeZone)) return null;
  const local = zonedParts(now, timeZone);
  const endHour = Math.floor(parsed.endMinute / 60);
  const endMinute = parsed.endMinute % 60;
  let candidate = zonedTimeToInstant(
    local.year,
    local.month,
    local.day,
    endHour,
    endMinute,
    timeZone,
  );
  if (candidate.getTime() <= now.getTime()) {
    const next = addCalendarDays(local.year, local.month, local.day, 1);
    candidate = zonedTimeToInstant(next.year, next.month, next.day, endHour, endMinute, timeZone);
  }
  return candidate;
}

/**
 * When the Muse should next work a Goal on its own, or `null` when proactivity is `off`.
 * Skips forward to the end of the quiet-hours window when the computed time would fall
 * inside one.
 */
export function nextWorkAt(
  settings: Pick<MuseSettings, "proactivity" | "quietHours">,
  lastWorkedAt: Date | null,
  now: Date,
  timeZone: string,
): Date | null {
  const intervalMs = proactivityIntervalMs(settings.proactivity);
  if (intervalMs === null) return null;
  const base = lastWorkedAt ?? now;
  let candidate = new Date(Math.max(base.getTime() + intervalMs, now.getTime()));
  const quietEnd = inQuietHours(settings.quietHours, candidate, timeZone)
    ? quietHoursEnd(settings.quietHours, candidate, timeZone)
    : null;
  if (quietEnd) candidate = quietEnd;
  return candidate;
}
