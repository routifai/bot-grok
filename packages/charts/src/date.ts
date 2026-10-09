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

/** Shown instead of the default when a chart's dates all fall within this span. */
const INTRADAY_SPAN_MS = 2 * 24 * 60 * 60 * 1000;
const INTRADAY_DATE_FORMAT: DateFormatSettings = {
  preset: "custom",
  customFormat: "MMM D, HH:mm",
};

/**
 * The format for a chart's date values: the person's own when set, else the default, which shows
 * the time when the dates span under two days (the day alone would repeat on every tick).
 */
export function dateFormatForValues(
  values: unknown[],
  settings?: DateFormatSettings | null,
): DateFormatSettings | null | undefined {
  if (settings) {
    return settings;
  }
  const instants = values.flatMap((value) => {
    const instant = typeof value === "string" ? parseIsoInstant(value) : null;
    return instant === null ? [] : [instant];
  });
  if (instants.length === 0) {
    return settings;
  }
  const span = Math.max(...instants) - Math.min(...instants);
  return span < INTRADAY_SPAN_MS ? INTRADAY_DATE_FORMAT : settings;
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
