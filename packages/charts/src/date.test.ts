import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { dateFormatForValues, formatDateValue, isIsoDateLike, parseIsoInstant } from "./date.js";

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

  it("shows the time when the dates span under two days", () => {
    const hours = ["2026-01-03T09:00:00Z", "2026-01-03T10:30:00Z", "2026-01-04T08:00:00Z"];
    const format = dateFormatForValues(hours);
    expect(hours.map((hour) => formatDateValue(hour, format))).toEqual([
      "Jan 3, 09:00",
      "Jan 3, 10:30",
      "Jan 4, 08:00",
    ]);
  });

  it("keeps the day for longer spans, and the person's own format", () => {
    const days = ["2026-01-03T09:00:00Z", "2026-01-06T09:00:00Z"];
    expect(dateFormatForValues(days)).toBeUndefined();
    const own = { preset: "iso", customFormat: undefined } as const;
    expect(dateFormatForValues(["2026-01-03T09:00:00Z"], own)).toBe(own);
  });
});
