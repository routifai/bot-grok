import { describe, expect, it } from "vitest";
import { CanvasNodeSchema, canvasTreeIsInteractive } from "./canvas.js";

describe("CanvasNodeSchema", () => {
  it("accepts a well-formed tree", () => {
    const result = CanvasNodeSchema.safeParse({
      type: "stack",
      children: [
        { type: "heading", props: { text: "Title" } },
        { type: "text", props: { text: "Hello **world**" } },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a container with no props at all", () => {
    const result = CanvasNodeSchema.safeParse({ type: "stack", children: [] });
    expect(result.success).toBe(true);
  });

  it("strips unknown props instead of rejecting", () => {
    const result = CanvasNodeSchema.safeParse({
      type: "heading",
      props: { text: "Hi", somethingUnknown: 42 },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.props).not.toHaveProperty("somethingUnknown");
  });

  it("rejects a leaf missing its required prop", () => {
    const result = CanvasNodeSchema.safeParse({ type: "heading", props: {} });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown node type", () => {
    const result = CanvasNodeSchema.safeParse({ type: "carousel", props: {} });
    expect(result.success).toBe(false);
  });

  it("validates a comparison table with a winner cell", () => {
    const result = CanvasNodeSchema.safeParse({
      type: "comparison_table",
      props: {
        columns: [{ id: "a", label: "Option A" }],
        rows: [{ label: "Price", cells: [{ columnId: "a", value: "$10", winner: true }] }],
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("canvasTreeIsInteractive", () => {
  it("is false for a plain display tree", () => {
    expect(
      canvasTreeIsInteractive({
        type: "stack",
        children: [{ type: "text", props: { text: "hi" } }],
      }),
    ).toBe(false);
  });

  it("is true when a choice node is nested inside layout", () => {
    expect(
      canvasTreeIsInteractive({
        type: "section",
        children: [
          {
            type: "choice",
            props: {
              options: [
                { value: "a", label: "A" },
                { value: "b", label: "B" },
              ],
            },
          },
        ],
      }),
    ).toBe(true);
  });

  it("is true for a bare form node", () => {
    expect(
      canvasTreeIsInteractive({
        type: "form",
        props: { fields: [{ kind: "text", name: "q", label: "Question" }] },
      }),
    ).toBe(true);
  });
});
