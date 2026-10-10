import { describe, expect, it } from "vitest";
import { rruleToSchedule, scheduleToRrule } from "./schedule.js";

describe("automation schedule", () => {
  it.each([
    [{ frequency: "daily", time: "09:05" } as const, "FREQ=DAILY;BYHOUR=9;BYMINUTE=5"],
    [
      { frequency: "weekly", time: "17:00", weekday: 4 } as const,
      "FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0",
    ],
    [
      { frequency: "monthly", time: "08:30", monthDay: 15 } as const,
      "FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=8;BYMINUTE=30",
    ],
  ])("round-trips %o", (schedule, rrule) => {
    expect(scheduleToRrule(schedule)).toBe(rrule);
    expect(rruleToSchedule(rrule)).toEqual(schedule);
  });

  it("returns null for rules the form cannot express", () => {
    expect(rruleToSchedule("FREQ=HOURLY")).toBeNull();
    expect(rruleToSchedule("FREQ=WEEKLY;BYDAY=MO,TU;BYHOUR=9;BYMINUTE=0")).toBeNull();
    expect(rruleToSchedule("FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=9;BYMINUTE=0")).toBeNull();
  });
});
