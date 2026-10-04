import { describe, expect, it } from "vitest";
import { cronFromRrule, rruleFromCron } from "./goal-cadence.js";

describe("goal cadence", () => {
  it.each([
    ["FREQ=DAILY;BYHOUR=7;BYMINUTE=30", "30 7 * * *"],
    ["FREQ=DAILY;BYHOUR=9", "0 9 * * *"],
    ["FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=7;BYMINUTE=30", "30 7 * * 1-5"],
    ["FREQ=WEEKLY;BYDAY=MO;BYHOUR=9", "0 9 * * 1"],
    ["RRULE:FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=8", "0 8 1 * *"],
    ["FREQ=HOURLY", "0 * * * *"],
  ])("reads %s as %s and writes it back", (rrule, cron) => {
    expect(cronFromRrule(rrule)).toBe(cron);
    expect(cronFromRrule(rruleFromCron(cron) as string)).toBe(cron);
  });

  it("leaves out a schedule with no fixed time or an unfamiliar shape", () => {
    expect(cronFromRrule("FREQ=DAILY")).toBeNull();
    expect(cronFromRrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;BYHOUR=9")).toBeNull();
    expect(cronFromRrule("FREQ=YEARLY;BYHOUR=9")).toBeNull();
  });

  it("refuses crons the engine side cannot express", () => {
    expect(rruleFromCron("*/5 * * * *")).toBeNull();
    expect(rruleFromCron("0 0 */2 * *")).toBeNull();
    expect(rruleFromCron("0 9 * 3 *")).toBeNull();
  });
});
