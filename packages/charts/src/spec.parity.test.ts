import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as z from "zod";

import { CHART_COLOR_PATTERN, ChartSourceSchema, ChartSpecSchema } from "./spec.js";

// The engine's pydantic spec (engine/.../superchat/charts/spec.py) and this zod spec describe the
// same call. tests/superchat/charts/test_charts.py writes the shape both must have to this file.
const parity = JSON.parse(
  readFileSync(new URL("../spec-parity.json", import.meta.url), "utf8"),
) as {
  chart_types: string[];
  chart: { properties: string[]; required: string[] };
  series: { properties: string[]; required: string[] };
  value_format: { properties: string[]; required: string[] };
  source: { properties: string[]; required: string[] };
  enums: Record<string, string[]>;
  color_pattern: string;
};

type JsonSchema = {
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
};

/** A field's schema with `optional`/`nullable` wrappers folded away. */
function inner(schema: JsonSchema | undefined): JsonSchema {
  if (!schema) throw new Error("missing field");
  const concrete = schema.anyOf?.find((s) => (s as { type?: string }).type !== "null");
  return concrete ?? schema;
}

const spec = z.toJSONSchema(ChartSpecSchema, { io: "input" }) as JsonSchema;
const source = z.toJSONSchema(ChartSourceSchema, { io: "input" }) as JsonSchema;
const props = spec.properties ?? {};
const series = inner(props.series).items as JsonSchema;
const valueFormat = inner(series.properties?.value_format);

const surface = (schema: JsonSchema) => ({
  properties: Object.keys(schema.properties ?? {}).sort(),
  required: [...(schema.required ?? [])].sort(),
});

describe("zod chart spec matches the pydantic one", () => {
  it("has the same fields and required fields", () => {
    expect(surface(spec)).toEqual(parity.chart);
    expect(surface(series)).toEqual(parity.series);
    expect(surface(valueFormat)).toEqual(parity.value_format);
    expect(surface(source)).toEqual(parity.source);
  });

  it("has the same chart types and enums", () => {
    expect(inner(props.chart_type).enum).toEqual(parity.chart_types);
    expect(inner(props.x_axis_type).enum).toEqual(parity.enums.x_axis_type);
    expect(inner(series.properties?.series_type).enum).toEqual(parity.enums.series_type);
    expect(inner(series.properties?.y_axis).enum).toEqual(parity.enums.y_axis);
    expect(inner(props.comparison_mode).enum).toEqual(parity.enums.comparison_mode);
    expect(inner(valueFormat.properties?.compact).enum).toEqual(parity.enums.compact);
  });

  it("uses the same color pattern, and rejects what could break out of an attribute", () => {
    expect(CHART_COLOR_PATTERN).toBe(parity.color_pattern);
    const color = (value: string) =>
      ChartSpecSchema.safeParse({
        chart_type: "bar",
        title: "T",
        x_axis_key: "k",
        x_axis_type: "category",
        series: [{ data_key: "v", color: value }],
      }).success;
    for (const ok of ["#1d1d1f", "rgb(0, 113, 227)", "tomato", "var(--chart-3)"]) {
      expect(color(ok), ok).toBe(true);
    }
    for (const bad of ['red" onload="x', "url(http://x)", "var(--background)", "<x>", "red;}"]) {
      expect(color(bad), bad).toBe(false);
    }
  });
});
