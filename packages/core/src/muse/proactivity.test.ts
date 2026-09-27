import { describe, expect, it } from "vitest";
import { inQuietHours, nextWorkAt, proactivityIntervalMs, quietHoursEnd } from "./proactivity.js";

const UTC = "UTC";
const NY = "America/New_York";

describe("proactivityIntervalMs", () => {
  it("maps each level to its interval", () => {
    expect(proactivityIntervalMs("low")).toBe(4 * 60 * 60_000);
    expect(proactivityIntervalMs("normal")).toBe(60 * 60_000);
    expect(proactivityIntervalMs("high")).toBe(20 * 60_000);
  });

  it("never works when off", () => {
    expect(proactivityIntervalMs("off")).toBeNull();
  });
});

describe("inQuietHours", () => {
  it("is never quiet with no window", () => {
    expect(inQuietHours(null, new Date("2026-01-01T12:00:00Z"), UTC)).toBe(false);
  });

  it("handles a same-day window", () => {
    const window = "13:00-14:00";
    expect(inQuietHours(window, new Date("2026-01-01T13:30:00Z"), UTC)).toBe(true);
    expect(inQuietHours(window, new Date("2026-01-01T12:59:00Z"), UTC)).toBe(false);
    expect(inQuietHours(window, new Date("2026-01-01T14:00:00Z"), UTC)).toBe(false); // end exclusive
  });

  it("wraps midnight", () => {
    const window = "22:00-08:00";
    expect(inQuietHours(window, new Date("2026-01-01T23:30:00Z"), UTC)).toBe(true);
    expect(inQuietHours(window, new Date("2026-01-01T07:59:00Z"), UTC)).toBe(true);
    expect(inQuietHours(window, new Date("2026-01-01T08:00:00Z"), UTC)).toBe(false);
    expect(inQuietHours(window, new Date("2026-01-01T21:59:00Z"), UTC)).toBe(false);
    expect(inQuietHours(window, new Date("2026-01-01T12:00:00Z"), UTC)).toBe(false);
  });

  it("rejects a malformed window instead of throwing", () => {
    expect(inQuietHours("not-a-window", new Date(), UTC)).toBe(false);
  });

  it("evaluates the window in the given time zone, not UTC", () => {
    // 09:00 UTC in January is 04:00 in New York (UTC-5): outside the window in UTC,
    // inside it in New York.
    const window = "22:00-08:00";
    const instant = new Date("2026-01-01T09:00:00Z");
    expect(inQuietHours(window, instant, UTC)).toBe(false);
    expect(inQuietHours(window, instant, NY)).toBe(true);
  });
});

describe("quietHoursEnd", () => {
  it("returns null when not currently in quiet hours", () => {
    expect(quietHoursEnd("22:00-08:00", new Date("2026-01-01T12:00:00Z"), UTC)).toBeNull();
    expect(quietHoursEnd(null, new Date("2026-01-01T23:30:00Z"), UTC)).toBeNull();
  });

  it("finds the end later the same day for a same-day window", () => {
    const end = quietHoursEnd("13:00-14:00", new Date("2026-01-01T13:30:00Z"), UTC);
    expect(end?.toISOString()).toBe("2026-01-01T14:00:00.000Z");
  });

  it("finds the end the next day when the window wraps midnight from the evening", () => {
    const end = quietHoursEnd("22:00-08:00", new Date("2026-01-01T23:30:00Z"), UTC);
    expect(end?.toISOString()).toBe("2026-01-02T08:00:00.000Z");
  });

  it("finds the end the same day when already past midnight inside a wrapped window", () => {
    const end = quietHoursEnd("22:00-08:00", new Date("2026-01-02T06:00:00Z"), UTC);
    expect(end?.toISOString()).toBe("2026-01-02T08:00:00.000Z");
  });

  it("is DST-safe across a time zone offset change", () => {
    // New York is UTC-5 in January (EST) and UTC-4 in July (EDT).
    const januaryEnd = quietHoursEnd("22:00-08:00", new Date("2026-01-15T10:00:00Z"), NY);
    expect(januaryEnd?.toISOString()).toBe("2026-01-15T13:00:00.000Z"); // 08:00 EST = 13:00 UTC

    const julyEnd = quietHoursEnd("22:00-08:00", new Date("2026-07-15T10:00:00Z"), NY);
    expect(julyEnd?.toISOString()).toBe("2026-07-15T12:00:00.000Z"); // 08:00 EDT = 12:00 UTC
  });
});

describe("nextWorkAt", () => {
  it("never schedules work when proactivity is off", () => {
    expect(
      nextWorkAt(
        { proactivity: "off", quietHours: null },
        new Date("2026-01-01T00:00:00Z"),
        new Date("2026-01-01T01:00:00Z"),
        UTC,
      ),
    ).toBeNull();
  });

  it("adds the level's interval to the last worked time", () => {
    const lastWorkedAt = new Date("2026-01-01T09:00:00Z");
    const now = new Date("2026-01-01T09:05:00Z");
    const next = nextWorkAt({ proactivity: "normal", quietHours: null }, lastWorkedAt, now, UTC);
    expect(next?.toISOString()).toBe("2026-01-01T10:00:00.000Z");
  });

  it("never worked before: schedules from now", () => {
    const now = new Date("2026-01-01T09:05:00Z");
    const next = nextWorkAt({ proactivity: "high", quietHours: null }, null, now, UTC);
    expect(next?.toISOString()).toBe("2026-01-01T09:25:00.000Z");
  });

  it("does not schedule work in the past when overdue", () => {
    const lastWorkedAt = new Date("2020-01-01T00:00:00Z");
    const now = new Date("2026-01-01T09:00:00Z");
    const next = nextWorkAt({ proactivity: "low", quietHours: null }, lastWorkedAt, now, UTC);
    expect(next?.getTime()).toBe(now.getTime());
  });

  it("skips a candidate inside quiet hours to the window's end", () => {
    // normal interval from 21:30 lands at 22:30, inside the default quiet window.
    const lastWorkedAt = new Date("2026-01-01T21:30:00Z");
    const now = new Date("2026-01-01T21:31:00Z");
    const next = nextWorkAt(
      { proactivity: "normal", quietHours: "22:00-08:00" },
      lastWorkedAt,
      now,
      UTC,
    );
    expect(next?.toISOString()).toBe("2026-01-02T08:00:00.000Z");
  });

  it("does not skip when the candidate lands outside quiet hours", () => {
    const lastWorkedAt = new Date("2026-01-01T12:00:00Z");
    const now = new Date("2026-01-01T12:01:00Z");
    const next = nextWorkAt(
      { proactivity: "normal", quietHours: "22:00-08:00" },
      lastWorkedAt,
      now,
      UTC,
    );
    expect(next?.toISOString()).toBe("2026-01-01T13:00:00.000Z");
  });
});
