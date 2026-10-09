import { describe, expect, it } from "vitest";
import { parseDashboardDocument } from "./dashboard.js";
import { DASHBOARD_FIXTURE } from "./fixtures.js";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("parseDashboardDocument", () => {
  it("reads a dashboard: its title, KPI tiles and charts, each a whole chart document", () => {
    const doc = parseDashboardDocument(bytes(DASHBOARD_FIXTURE));
    expect(doc?.title).toBe("Sales 2026");
    expect(doc?.kpis).toHaveLength(3);
    expect(doc?.charts[0]?.wide).toBe(true);
    expect(doc?.charts[1]?.source.file).toBe("region.csv");
  });

  it("refuses what is not a dashboard", () => {
    expect(parseDashboardDocument(bytes({ ...DASHBOARD_FIXTURE, charts: [] }))).toBeNull();
    expect(parseDashboardDocument(bytes(DASHBOARD_FIXTURE.charts[0]))).toBeNull();
    expect(parseDashboardDocument(new TextEncoder().encode("not json"))).toBeNull();
  });
});
