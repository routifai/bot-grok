// A Goal's check-in schedule is the RRULE of the engine scheduled task that advances it
// (docs/adr/0005-proactive-work-is-scheduled-helper-runs.md). The Goals screen speaks the cron
// shapes its schedule picker produces (packages/core cron.ts); these two functions translate the
// shapes both sides share (hourly, daily, weekdays, weekly, monthly) and nothing else.

const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

function rruleParts(rrule: string): Map<string, string> {
  const parts = new Map<string, string>();
  for (const part of rrule.replace(/^RRULE:/i, "").split(";")) {
    const [key, value] = part.split("=");
    if (key && value) parts.set(key.trim().toUpperCase(), value.trim().toUpperCase());
  }
  return parts;
}

const integer = (value: string | undefined): number | null =>
  value !== undefined && /^\d+$/.test(value) ? Number(value) : null;

/** The cron for an RRULE the picker can show, or `null` (an unfamiliar shape, or no fixed time). */
export function cronFromRrule(rrule: string): string | null {
  const parts = rruleParts(rrule);
  const freq = parts.get("FREQ");
  if ((parts.get("INTERVAL") ?? "1") !== "1") return null;
  const minute = parts.has("BYMINUTE") ? integer(parts.get("BYMINUTE")) : 0;
  if (minute === null || minute > 59) return null;
  if (freq === "HOURLY") return parts.has("BYHOUR") || minute !== 0 ? null : "0 * * * *";
  const hour = integer(parts.get("BYHOUR"));
  if (hour === null || hour > 23) return null;
  if (freq === "DAILY") return parts.has("BYDAY") ? null : `${minute} ${hour} * * *`;
  if (freq === "WEEKLY") {
    const days = (parts.get("BYDAY") ?? "").split(",").map((day) => BYDAY.indexOf(day as never));
    if (days.length === 0 || days.some((day) => day < 0)) return null;
    const sorted = [...new Set(days)].sort((a, b) => a - b);
    const dow = sorted.join(",") === "1,2,3,4,5" ? "1-5" : sorted.join(",");
    return `${minute} ${hour} * * ${dow}`;
  }
  if (freq === "MONTHLY") {
    const day = integer(parts.get("BYMONTHDAY"));
    return day === null || day < 1 || day > 31 ? null : `${minute} ${hour} ${day} * *`;
  }
  return null;
}

/** The RRULE for a cron the picker produces, or `null` for a shape the engine side can't express. */
export function rruleFromCron(cron: string): string | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteField = "", hourField = "", day = "", month = "", dow = ""] = fields;
  if (month !== "*") return null;
  if (cron.trim() === "0 * * * *") return "FREQ=HOURLY";
  const minute = integer(minuteField);
  const hour = integer(hourField);
  if (minute === null || hour === null || minute > 59 || hour > 23) return null;
  const time = `BYHOUR=${hour};BYMINUTE=${minute}`;
  if (day === "*" && dow === "*") return `FREQ=DAILY;${time}`;
  if (day === "*") {
    const days = (dow === "1-5" ? "1,2,3,4,5" : dow).split(",").map(Number);
    if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return null;
    return `FREQ=WEEKLY;BYDAY=${days.map((d) => BYDAY[d]).join(",")};${time}`;
  }
  const monthDay = integer(day);
  if (dow === "*" && monthDay !== null && monthDay >= 1 && monthDay <= 31) {
    return `FREQ=MONTHLY;BYMONTHDAY=${monthDay};${time}`;
  }
  return null;
}
