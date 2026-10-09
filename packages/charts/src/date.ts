/* Portions modified from getnao/nao apps/shared/src/date.ts@5bde830, Apache-2.0; changes: budget-period helpers removed, strict-index fixes. */
export const DATE_FORMAT_PRESETS = ["european", "american", "iso", "custom"] as const;
export type DateFormatPreset = (typeof DATE_FORMAT_PRESETS)[number];

export interface DateFormatSettings {
  preset: DateFormatPreset;
  customFormat?: string;
}

/**
 * Project-level display settings persisted on the project row.
 *
 * Currently only carries the date format used in chart axes, tooltips,
 * legends and SQL query result tables, but is shaped as an object so we can
 * add more display preferences (number format, timezone, …) without another
 * migration.
 */
export interface DisplaySettings {
  dateFormat?: DateFormatSettings;
}

/** "Jan 3, 2026": unlike DD/MM and MM/DD it cannot be read two ways. */
export const DEFAULT_DATE_FORMAT_SETTINGS: DateFormatSettings = {
  preset: "custom",
  customFormat: "MMM D, YYYY",
};

export const DATE_FORMAT_PRESET_PATTERNS: Record<Exclude<DateFormatPreset, "custom">, string> = {
  european: "DD/MM/YYYY",
  american: "MM/DD/YYYY",
  iso: "YYYY-MM-DD",
};

/**
 * Tokens supported by {@link formatDateValue}. We document these inline in the
 * settings UI rather than linking out to date-fns, since we only support a
 * focused subset and using date-fns tokens (e.g. `yyyy-MM-dd`) would silently
 * produce wrong output.
 */
export const SUPPORTED_DATE_FORMAT_TOKENS: Array<{ token: string; description: string }> = [
  { token: "YYYY", description: "4-digit year (e.g. 2024)" },
  { token: "YY", description: "2-digit year (e.g. 24)" },
  { token: "MMMM", description: "Month name (e.g. March)" },
  { token: "MMM", description: "Short month name (e.g. Mar)" },
  { token: "MM", description: "0-padded month (e.g. 03)" },
  { token: "M", description: "Numeric month (e.g. 3)" },
  { token: "DD", description: "0-padded day (e.g. 05)" },
  { token: "D", description: "Numeric day (e.g. 5)" },
  { token: "dddd", description: "Weekday (e.g. Friday)" },
  { token: "ddd", description: "Short weekday (e.g. Fri)" },
  { token: "HH", description: "0-padded 24-hour (e.g. 09)" },
  { token: "mm", description: "0-padded minute (e.g. 05)" },
];

/**
 * The ISO shapes a chart date may take. The engine's `_ISO_DATE` / `_instant`
 * (engine/.../superchat/charts/data.py) accept the same set; `date-parity.json` pins both.
 * `YYYY-MM`, `YYYY-MM-DD`, then an optional time (space or `T`, any number of fraction digits)
 * and an optional `Z` or `±HH:MM` / `±HHMM` offset. No offset means UTC.
 */
const ISO_DATE_REGEX =
  /^(\d{4})-(\d{2})(?:-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?)?)?$/;

/** Milliseconds since the epoch for an ISO date or date-time, or null when it is not a real one. */
export function parseIsoInstant(text: string): number | null {
  const match = ISO_DATE_REGEX.exec(text);
  if (!match) {
    return null;
  }
  const [, y, mo, d, h, mi, sec, frac, zone] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d ?? "1");
  const hour = Number(h ?? "0");
  const minute = Number(mi ?? "0");
  const second = Number(sec ?? "0");
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, Number(`${frac ?? ""}000`.slice(0, 3)));
  const real =
    year >= 1 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    hour < 24 &&
    minute < 60 &&
    second < 60;
  if (!real) {
    return null;
  }
  let offsetMinutes = 0;
  if (zone && zone !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    const zoneHours = Number(digits.slice(0, 2));
    const zoneMinutes = Number(digits.slice(2));
    if (zoneHours >= 24 || zoneMinutes >= 60) {
      return null;
    }
    offsetMinutes = (zone.startsWith("-") ? -1 : 1) * (zoneHours * 60 + zoneMinutes);
  }
  return date.getTime() - offsetMinutes * 60_000;
}

/** True when the input is an ISO date or date-time the engine would accept as a chart date. */
export function isIsoDateLike(value: unknown): boolean {
  return typeof value === "string" && parseIsoInstant(value) !== null;
}

/** How far apart a chart's dates are: what one step on its axis means. */
export type DateGranularity = "year" | "month" | "day" | "time";

const DAY_MS = 24 * 60 * 60 * 1000;

function instantsOf(values: unknown[]): number[] {
  const found = new Set<number>();
  for (const value of values) {
    const instant = typeof value === "string" ? parseIsoInstant(value) : null;
    if (instant !== null) found.add(instant);
  }
  return [...found].sort((a, b) => a - b);
}

function isMidnight(instant: number): boolean {
  return instant % DAY_MS === 0;
}

/**
 * The step a chart's dates move by, from the values themselves: every date on the first of a
 * month is monthly (the first of January only: yearly), dates at least a day apart are daily, and
 * anything closer is intraday. Null when there are no dates.
 */
export function dateGranularity(values: unknown[]): DateGranularity | null {
  const instants = instantsOf(values);
  if (instants.length === 0) return null;
  const dates = instants.map((instant) => new Date(instant));
  if (instants.every(isMidnight) && dates.every((date) => date.getUTCDate() === 1)) {
    return instants.length > 1 && dates.every((date) => date.getUTCMonth() === 0)
      ? "year"
      : "month";
  }
  let smallestGap = Number.POSITIVE_INFINITY;
  for (let i = 1; i < instants.length; i++) {
    smallestGap = Math.min(smallestGap, (instants[i] as number) - (instants[i - 1] as number));
  }
  // One timestamp, or every gap a day or more: the time of day is noise.
  if (instants.every(isMidnight) || smallestGap >= DAY_MS - 60 * 60 * 1000) return "day";
  return "time";
}

const custom = (customFormat: string): DateFormatSettings => ({ preset: "custom", customFormat });

/**
 * The format for a chart's date ticks: the person's own when set, else the shortest one that
 * names each step: "Jan" for months ("Jan 2026" once they span years), "Jan 3" for days ("Jan 3,
 * 2026" across years), "09:30" within one day and "Jan 3, 09:30" across days.
 */
export function dateFormatForValues(
  values: unknown[],
  settings?: DateFormatSettings | null,
): DateFormatSettings | null | undefined {
  if (settings) {
    return settings;
  }
  const granularity = dateGranularity(values);
  if (granularity === null) {
    return settings;
  }
  const instants = instantsOf(values);
  const first = new Date(instants[0] as number);
  const last = new Date(instants[instants.length - 1] as number);
  const oneYear = first.getUTCFullYear() === last.getUTCFullYear();
  const oneDay = first.toISOString().slice(0, 10) === last.toISOString().slice(0, 10);
  switch (granularity) {
    case "year":
      return custom("YYYY");
    case "month":
      return custom(oneYear && instants.length > 1 ? "MMM" : "MMM YYYY");
    case "day":
      return custom(oneYear && instants.length > 1 ? "MMM D" : "MMM D, YYYY");
    case "time":
      return custom(oneDay ? "HH:mm" : "MMM D, HH:mm");
  }
}

/**
 * The format for one date read on its own (a tooltip): the person's own when set, else the full
 * date at the chart's step ("Jan 2026", "Jan 3, 2026", "Jan 3, 2026, 09:30").
 */
export function fullDateFormatForValues(
  values: unknown[],
  settings?: DateFormatSettings | null,
): DateFormatSettings | null | undefined {
  if (settings) {
    return settings;
  }
  switch (dateGranularity(values)) {
    case "year":
      return custom("YYYY");
    case "month":
      return custom("MMM YYYY");
    case "time":
      return custom("MMM D, YYYY, HH:mm");
    default:
      return settings;
  }
}

/**
 * Resolves the effective pattern for the given settings, falling back to the
 * default ("MMM D, YYYY") when the custom pattern is missing.
 */
export function resolveDateFormatPattern(settings?: DateFormatSettings | null): string {
  const preset = settings?.preset ?? DEFAULT_DATE_FORMAT_SETTINGS.preset;
  if (preset === "custom") {
    const trimmed = settings?.customFormat?.trim();
    if (trimmed) {
      return trimmed;
    }
    return DEFAULT_DATE_FORMAT_SETTINGS.customFormat ?? DATE_FORMAT_PRESET_PATTERNS.iso;
  }
  return DATE_FORMAT_PRESET_PATTERNS[preset];
}

/**
 * Formats an ISO date-like value using one of {@link SUPPORTED_DATE_FORMAT_TOKENS},
 * in UTC. Quoted segments wrapped in `[...]` are emitted verbatim. Non-date
 * inputs are stringified unchanged.
 */
export function formatDateValue(value: unknown, settings?: DateFormatSettings | null): string {
  const instant = typeof value === "string" ? parseIsoInstant(value) : null;
  if (instant === null) {
    return String(value ?? "");
  }
  const date = new Date(instant);
  const pattern = resolveDateFormatPattern(settings);
  return formatDateWithPattern(date, pattern);
}

const MONTH_NAMES_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MONTH_NAMES_SHORT = MONTH_NAMES_LONG.map((m) => m.slice(0, 3));
const WEEKDAY_NAMES_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const WEEKDAY_NAMES_SHORT = WEEKDAY_NAMES_LONG.map((w) => w.slice(0, 3));

const TOKEN_REGEX = /YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|mm|\[([^\]]*)\]/g;

function formatDateWithPattern(date: Date, pattern: string): string {
  const year = date.getUTCFullYear();
  const monthIndex = date.getUTCMonth();
  const day = date.getUTCDate();
  const weekdayIndex = date.getUTCDay();

  return pattern.replace(TOKEN_REGEX, (token, literal: string | undefined): string => {
    if (literal !== undefined) {
      return literal;
    }
    switch (token) {
      case "YYYY":
        return String(year).padStart(4, "0");
      case "YY":
        return String(year % 100).padStart(2, "0");
      case "MMMM":
        return MONTH_NAMES_LONG[monthIndex] ?? "";
      case "MMM":
        return MONTH_NAMES_SHORT[monthIndex] ?? "";
      case "MM":
        return String(monthIndex + 1).padStart(2, "0");
      case "M":
        return String(monthIndex + 1);
      case "DD":
        return String(day).padStart(2, "0");
      case "D":
        return String(day);
      case "dddd":
        return WEEKDAY_NAMES_LONG[weekdayIndex] ?? "";
      case "ddd":
        return WEEKDAY_NAMES_SHORT[weekdayIndex] ?? "";
      case "HH":
        return String(date.getUTCHours()).padStart(2, "0");
      case "mm":
        return String(date.getUTCMinutes()).padStart(2, "0");
      default:
        return token;
    }
  });
}
