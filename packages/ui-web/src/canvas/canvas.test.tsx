import type { CanvasNode } from "@nova/contracts";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CanvasView } from "./CanvasTree.js";

// The lingui babel macro only runs through apps/web's Vite build; plain vitest never
// compiles it, so `t`/`Trans` throw unless mocked here (same shim other tests in this repo
// use for the same reason).
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((acc, part, i) => acc + part + (i < values.length ? String(values[i]) : ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

describe("CanvasView", () => {
  it("renders a mixed layout/content tree", () => {
    const tree: CanvasNode = {
      type: "stack",
      props: { gap: "lg" },
      children: [
        { type: "heading", props: { text: "Nova Canvas" } },
        { type: "text", props: { text: "Compare **five** cards." } },
        {
          type: "grid",
          props: { columns: 2 },
          children: [
            { type: "badge", props: { text: "New", tone: "success" } },
            {
              type: "stat",
              props: { label: "Annual fee", value: 139, unit: "$", delta: -10, trend: "down" },
            },
          ],
        },
      ],
    };
    const html = renderToString(<CanvasView tree={tree} />);
    expect(html).toContain("Nova Canvas");
    expect(html).toContain("Compare");
    expect(html).toContain("<strong>five</strong>");
    expect(html).toContain("New");
    expect(html).toContain("139");
  });

  it("renders an item card with a monogram and pros/cons", () => {
    const tree: CanvasNode = {
      type: "item_card",
      props: {
        title: "Scotiabank Passport Visa Infinite",
        highlight: "Best for travel",
        stats: [{ label: "Annual fee", value: "$139" }],
        pros: ["No FX fee"],
        cons: ["High income requirement"],
      },
    };
    const html = renderToString(<CanvasView tree={tree} />);
    expect(html).toContain("Scotiabank Passport Visa Infinite");
    expect(html).toContain("Best for travel");
    expect(html).toContain("No FX fee");
    expect(html).toContain("High income requirement");
    // Monogram initials derived from the title when none is given.
    expect(html).toContain("SP");
  });

  it("renders a comparison table with a winner cell and footer", () => {
    const tree: CanvasNode = {
      type: "comparison_table",
      props: {
        columns: [
          { id: "a", label: "Card A" },
          { id: "b", label: "Card B" },
        ],
        rows: [
          {
            label: "Annual fee",
            cells: [
              { columnId: "a", value: "$139" },
              { columnId: "b", value: "$0", winner: true },
            ],
          },
          {
            label: "Lounge access",
            cells: [
              { columnId: "a", value: true },
              { columnId: "b", value: false },
            ],
          },
        ],
        footer: "Best for frequent travelers: Card A",
      },
    };
    const html = renderToString(<CanvasView tree={tree} />);
    expect(html).toContain("Card A");
    expect(html).toContain("Annual fee");
    expect(html).toContain("Best for frequent travelers");
    expect(html).toContain('aria-label="Yes"');
    expect(html).toContain('aria-label="No"');
  });

  it("renders a bar chart with accessible labels and a data table fallback", () => {
    const tree: CanvasNode = {
      type: "chart",
      props: {
        kind: "bar",
        title: "Annual fees",
        unit: "$",
        series: [
          {
            data: [
              { label: "Card A", value: 139 },
              { label: "Card B", value: 0 },
            ],
          },
        ],
      },
    };
    const html = renderToString(<CanvasView tree={tree} />);
    expect(html).toContain("Annual fees");
    expect(html).toContain("Card A");
    expect(html).toContain("<svg");
    expect(html).toContain('class="sr-only"');
  });

  it("renders choice buttons with the question", () => {
    const tree: CanvasNode = {
      type: "choice",
      props: {
        question: "Which card fits you best?",
        options: [
          { value: "a", label: "Card A" },
          { value: "b", label: "Card B" },
        ],
      },
    };
    const html = renderToString(<CanvasView tree={tree} />);
    expect(html).toContain("Which card fits you best?");
    expect(html).toContain("Card A");
  });

  it("renders a timeline with status dots", () => {
    const tree: CanvasNode = {
      type: "timeline",
      props: {
        items: [
          { title: "Applied", status: "done" },
          { title: "Approved", status: "active" },
          { title: "Card shipped", status: "upcoming" },
        ],
      },
    };
    const html = renderToString(<CanvasView tree={tree} />);
    expect(html).toContain("Applied");
    expect(html).toContain("Card shipped");
  });

  it("renders a source list as plain domain text, never a favicon image", () => {
    const tree: CanvasNode = {
      type: "source_list",
      props: {
        sources: [
          { title: "Bank site", url: "https://www.example.com/cards", domain: "example.com" },
        ],
      },
    };
    const html = renderToString(<CanvasView tree={tree} />);
    expect(html).toContain("example.com");
    expect(html).not.toContain("favicon");
    expect(html).not.toContain("<img");
  });

  it("falls back to nothing for an unknown node type instead of throwing", () => {
    const tree = { type: "not_a_real_type" } as unknown as CanvasNode;
    expect(() => renderToString(<CanvasView tree={tree} />)).not.toThrow();
  });
});
