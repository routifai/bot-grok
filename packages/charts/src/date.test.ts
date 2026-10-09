import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  dateFormatForValues,
  dateGranularity,
  formatDateValue,
  fullDateFormatForValues,
  isIsoDateLike,
  parseIsoInstant,
} from "./date.js";

// The engine's `_instant` (superchat/charts/data.py) accepts the same set: its test reads this file.
const parity = JSON.parse(
  readFileSync(new URL("../date-parity.json", import.meta.url), "utf8"),
) as {
  valid: string[];
  invalid: string[];
  instants: [string, string][];
};

describe("chart dates match the engine's", () => {
  it("accepts and refuses the same texts", () => {
    expect(parity.valid.filter((text) => !isIsoDateLike(text))).toEqual([]);
    expect(parity.invalid.filter((text) => isIsoDateLike(text))).toEqual([]);
  });

  it("reads the same instants", () => {
    for (const [text, utc] of parity.instants) {
      expect(parseIsoInstant(text)).toBe(parseIsoInstant(utc));
    }
  });
});

describe("date format", () => {
  it("defaults to a day that cannot be read two ways", () => {
    expect(formatDateValue("2026-01-03")).toBe("Jan 3, 2026");
    expect(formatDateValue("2026-01")).toBe("Jan 1, 2026");
  });

  const ticks = (values: string[]) => {
    const format = dateFormatForValues(values);
    return values.map((value) => formatDateValue(value, format));
  };

  it("reads the step from the dates", () => {
    expect(dateGranularity(["2026-01-01", "2026-02-01", "2026-03-01"])).toBe("month");
    expect(dateGranularity(["2026-01", "2026-02"])).toBe("month");
    expect(dateGranularity(["2024-01-01", "2025-01-01"])).toBe("year");
    expect(dateGranularity(["2026-01-03", "2026-01-04"])).toBe("day");
    expect(dateGranularity(["2026-01-03T09:00:00Z", "2026-01-06T09:00:00Z"])).toBe("day");
    expect(dateGranularity(["2026-01-03T09:00:00Z", "2026-01-03T10:00:00Z"])).toBe("time");
    expect(dateGranularity(["Q1", 4])).toBeNull();
  });

  it("names a month by its month, with the year only across years", () => {
    const months = Array.from(
      { length: 11 },
      (_, i) => `2026-${String(i + 1).padStart(2, "0")}-01`,
    );
    expect(ticks(months)).toEqual([
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
    ]); // fmt: skip
    expect(ticks(["2025-11-01", "2025-12-01", "2026-01-01"])).toEqual([
      "Nov 2025",
      "Dec 2025",
      "Jan 2026",
    ]);
  });

  it("names a day by month and day, a year by its number", () => {
    expect(ticks(["2026-01-03", "2026-01-04"])).toEqual(["Jan 3", "Jan 4"]);
    expect(ticks(["2025-12-31", "2026-01-01T00:00:00Z"])).toEqual(["Dec 31, 2025", "Jan 1, 2026"]);
    expect(ticks(["2024-01-01", "2025-01-01"])).toEqual(["2024", "2025"]);
  });

  it("shows only the time within one day", () => {
    expect(ticks(["2026-01-03T09:00:00Z", "2026-01-03T10:30:00Z"])).toEqual(["09:00", "10:30"]);
  });

  it("reads a date in full in the tooltip", () => {
    const months = ["2026-01-01", "2026-02-01"];
    expect(formatDateValue(months[0], fullDateFormatForValues(months))).toBe("Jan 2026");
    const days = ["2026-01-03", "2026-01-04"];
    expect(formatDateValue(days[0], fullDateFormatForValues(days))).toBe("Jan 3, 2026");
  });

  it("shows the time when the dates span under two days", () => {
    const hours = ["2026-01-03T09:00:00Z", "2026-01-03T10:30:00Z", "2026-01-04T08:00:00Z"];
    const format = dateFormatForValues(hours);
    expect(hours.map((hour) => formatDateValue(hour, format))).toEqual([
      "Jan 3, 09:00",
      "Jan 3, 10:30",
      "Jan 4, 08:00",
    ]);
  });

  it("keeps the person's own format", () => {
    const own = { preset: "iso", customFormat: undefined } as const;
    expect(dateFormatForValues(["2026-01-03T09:00:00Z"], own)).toBe(own);
  });
});
