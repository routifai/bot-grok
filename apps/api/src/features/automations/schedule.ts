import type { AutomationSchedule } from "@superchat/contracts";

const DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

/** The form's plain choices as the engine's RRULE (evaluated in the task's timezone). */
export function scheduleToRrule(schedule: AutomationSchedule): string {
  const [hour, minute] = schedule.time.split(":").map(Number) as [number, number];
  const parts =
    schedule.frequency === "daily"
      ? ["FREQ=DAILY"]
      : schedule.frequency === "weekly"
        ? ["FREQ=WEEKLY", `BYDAY=${DAYS[schedule.weekday ?? 0]}`]
        : ["FREQ=MONTHLY", `BYMONTHDAY=${schedule.monthDay ?? 1}`];
  return [...parts, `BYHOUR=${hour}`, `BYMINUTE=${minute}`].join(";");
}

/** The inverse for rules this module wrote; `null` for any other rule. */
export function rruleToSchedule(rrule: string): AutomationSchedule | null {
  const fields = new Map(
    rrule
      .replace(/^RRULE:/, "")
      .split(";")
      .map((part) => part.split("=") as [string, string | undefined]),
  );
  const hour = Number(fields.get("BYHOUR"));
  const minute = Number(fields.get("BYMINUTE"));
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || fields.size > 4) return null;
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const freq = fields.get("FREQ");
  if (freq === "DAILY" && fields.size === 3) return { frequency: "daily", time };
  if (freq === "WEEKLY") {
    const weekday = DAYS.indexOf(fields.get("BYDAY") as (typeof DAYS)[number]);
    return weekday >= 0 ? { frequency: "weekly", time, weekday } : null;
  }
  if (freq === "MONTHLY") {
    const monthDay = Number(fields.get("BYMONTHDAY"));
    return monthDay >= 1 && monthDay <= 28 ? { frequency: "monthly", time, monthDay } : null;
  }
  return null;
}
