// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  table: vi.fn(),
  editTable: vi.fn(),
  tableRange: vi.fn(),
  listVersions: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({ rpc: { artifacts: api, sheets: api } }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...v: unknown[]) =>
      parts.reduce((out, part, i) => out + part + (v[i] ?? ""), ""),
  }),
}));

import { SheetView } from "./SheetView";
import { setSheetAsk, useSheetAsk, useSheetAskTarget } from "./sheet-ask";

i18n.loadAndActivate({ locale: "en", messages: {} });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  setSheetAsk(null);
  document.body.innerHTML = "";
});

const cell = (v: string | number | null, f: string | null = null) => ({
  v,
  f,
  t: v === null ? null : typeof v === "number" ? "n" : "s",
});
const tableOf = (id: string, version: number, amount = 64000) => ({
  artifactId: id,
  version,
  kind: "xlsx",
  sheets: [
    {
      name: "Sales",
      frozenRows: 1,
      nRows: 4,
      nCols: 3,
      truncated: false,
      rows: [
        [cell("Region"), cell("Account"), cell("Revenue")],
        [cell("Ontario"), cell("Northwind"), cell(amount)],
        [cell("Quebec"), cell("Acme"), cell(48000)],
        [cell("Total"), cell(null), cell(null, "=SUM(C2:C3)")],
      ],
    },
  ],
});
const ver = (id: string, version: number, extra = {}) => ({
  id,
  version,
  name: "q3.xlsx",
  createdAt: "",
  origin: "ai",
  parentVersionId: null,
  ...extra,
});

const tick = () => act(async () => {});
async function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<I18nProvider i18n={i18n}>{node}</I18nProvider>));
  await tick();
  return container;
}
const at = (container: HTMLElement, r: number, c: number) =>
  container.querySelector<HTMLElement>(`td[data-r="${r}"][data-c="${c}"]`) as HTMLElement;
const button = (container: HTMLElement, name: RegExp) =>
  [...container.querySelectorAll("button")].find((b) =>
    name.test(b.getAttribute("aria-label") ?? b.textContent ?? ""),
  ) as HTMLButtonElement;
const mouse = (el: Element, type: string, init: MouseEventInit = {}) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, ...init }));
  });
const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init }));
  });
const grid = (container: HTMLElement) => container.querySelector('[role="grid"]') as HTMLElement;
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const artifact = { id: "a2", name: "q3.xlsx", version: 2 };

it("renders the grid: frozen header, right-aligned numbers, computed and fallback formulas", async () => {
  const withUnsupported = tableOf("a2", 2);
  withUnsupported.sheets[0]!.rows[3]![1] = cell(null, "=VLOOKUP(1,A1:B2,2,FALSE)");
  api.table.mockResolvedValue(withUnsupported);
  api.listVersions.mockResolvedValue([ver("a2", 2)]);
  const view = await mount(<SheetView artifact={artifact} />);

  expect(view.querySelectorAll("thead th")[1]?.textContent).toBe("A");
  const header = at(view, 0, 0);
  expect(header.textContent).toBe("Region");
  expect(header.className).toContain("sticky");
  expect(at(view, 1, 0).className).not.toContain("sticky");

  expect(at(view, 1, 2).textContent).toBe("64000");
  expect(at(view, 1, 2).className).toContain("text-right");
  expect(at(view, 1, 0).className).toContain("text-left");

  // A formula with no cached value is worked out in the browser.
  expect(at(view, 3, 2).textContent).toBe("112000");
  expect(at(view, 3, 2).className).toContain("text-right");
  // One it cannot work out shows its text, muted.
  const unsupported = at(view, 3, 1);
  expect(unsupported.textContent).toBe("=VLOOKUP(1,A1:B2,2,FALSE)");
  expect(unsupported.className).toContain("text-muted-foreground");
});

it("marks cells the person changed by hand against the last version Nova saved", async () => {
  api.table.mockImplementation(async ({ artifactId }: { artifactId: string }) =>
    artifactId === "a1" ? tableOf("a1", 1, 64000) : tableOf("a2", 2, 70000),
  );
  api.listVersions.mockResolvedValue([
    ver("a2", 2, { origin: "manual", parentVersionId: "a1" }),
    ver("a1", 1),
  ]);
  const view = await mount(<SheetView artifact={artifact} />);

  expect(view.textContent).toContain("Edited by you");
  expect(view.querySelectorAll('[role="img"][aria-label="Edited by you"]').length).toBe(1);
  expect(at(view, 1, 2).querySelector('[aria-label="Edited by you"]')).not.toBeNull();
  expect(at(view, 1, 0).querySelector('[aria-label="Edited by you"]')).toBeNull();
  expect(view.querySelector('[data-testid="sheet-changes"]')?.textContent).toContain(
    "You changed 1 cell on Sales",
  );
});

it("saves an edit as a new version and switches to it", async () => {
  api.table.mockImplementation(async ({ artifactId }: { artifactId: string }) =>
    artifactId === "a3" ? tableOf("a3", 3, 70000) : tableOf("a2", 2),
  );
  api.listVersions.mockResolvedValue([ver("a2", 2)]);
  api.editTable.mockResolvedValue({ id: "a3", version: 3 });
  const onEdited = vi.fn();
  const view = await mount(<SheetView artifact={artifact} onEdited={onEdited} />);

  // Read-only until Edit is on: typing does nothing.
  await mouse(at(view, 1, 2), "mousedown");
  await key(grid(view), "7");
  expect(view.querySelector("input")).toBeNull();

  await act(async () => button(view, /^Edit$/).click());
  await key(grid(view), "7");
  const input = view.querySelector("input") as HTMLInputElement;
  expect(input.value).toBe("7");
  await type(input, "70000");
  await key(input, "Enter");
  await tick();

  expect(api.editTable).toHaveBeenCalledWith({
    artifactId: "a2",
    baseVersion: 2,
    edits: [{ sheet: "Sales", row: 1, col: 2, value: 70000 }],
  });
  expect(onEdited).toHaveBeenCalledWith("a3");
  expect(api.table).toHaveBeenCalledWith({ artifactId: "a3" });
  expect(at(view, 1, 2).textContent).toBe("70000");
});

it("reloads and re-applies the edit once when the version is stale", async () => {
  api.table.mockImplementation(async ({ artifactId }: { artifactId: string }) =>
    artifactId === "a9"
      ? tableOf("a9", 9, 70000)
      : tableOf(artifactId, artifactId === "a8" ? 8 : 2),
  );
  // Newest at open is a2; by the time the edit lands, a8 has been saved.
  api.listVersions
    .mockResolvedValueOnce([ver("a2", 2)])
    .mockResolvedValue([ver("a8", 8), ver("a2", 2)]);
  api.editTable
    .mockRejectedValueOnce({ code: "CONFLICT" })
    .mockResolvedValueOnce({ id: "a9", version: 9 });
  const view = await mount(<SheetView artifact={artifact} />);
  await act(async () => button(view, /^Edit$/).click());
  await mouse(at(view, 1, 2), "mousedown");
  await key(grid(view), "Enter");
  await type(view.querySelector("input") as HTMLInputElement, "70000");
  await key(view.querySelector("input") as HTMLInputElement, "Enter");
  await tick();

  expect(api.editTable).toHaveBeenCalledTimes(2);
  expect(api.editTable).toHaveBeenLastCalledWith({
    artifactId: "a8",
    baseVersion: 8,
    edits: [{ sheet: "Sales", row: 1, col: 2, value: 70000 }],
  });
  expect(view.querySelector('[role="alert"]')).toBeNull();
});

it("shows a calm error and keeps the file as it was when saving fails twice", async () => {
  api.table.mockResolvedValue(tableOf("a2", 2));
  api.listVersions.mockResolvedValue([ver("a2", 2)]);
  api.editTable.mockRejectedValue(new Error("boom"));
  const view = await mount(<SheetView artifact={artifact} />);
  await act(async () => button(view, /^Edit$/).click());
  await mouse(at(view, 1, 2), "mousedown");
  await key(grid(view), "Enter");
  await type(view.querySelector("input") as HTMLInputElement, "1");
  await key(view.querySelector("input") as HTMLInputElement, "Enter");
  await tick();

  expect(view.querySelector('[role="alert"]')?.textContent).toBe("Couldn't save that change.");
  expect(at(view, 1, 2).textContent).toBe("64000");
});

it("selects a range with shift-click and puts it in the composer as a chip payload", async () => {
  api.table.mockResolvedValue(tableOf("a2", 2));
  api.listVersions.mockResolvedValue([ver("a2", 2)]);
  api.tableRange.mockResolvedValue({ version: 2, block: "[selection ...]" });
  let latest: ReturnType<typeof useSheetAsk> = null;
  function Probe() {
    useSheetAskTarget();
    latest = useSheetAsk();
    return null;
  }
  const view = await mount(
    <>
      <Probe />
      <SheetView artifact={artifact} />
    </>,
  );

  await mouse(at(view, 1, 2), "mousedown");
  await mouse(at(view, 2, 2), "mousedown", { shiftKey: true });
  const ask = button(view, /^Ask Nova about C2:C3$/);
  expect(ask).toBeTruthy();
  expect(view.textContent).toContain("2 cells · Sum 112,000");

  await act(async () => ask.click());
  await tick();
  expect(api.tableRange).toHaveBeenCalledWith({ artifactId: "a2", sheet: "Sales", range: "C2:C3" });
  expect(latest).toEqual({ label: "Sales!C2:C3 · 2 cells", block: "[selection ...]" });
});

it("moves the active cell with the arrow keys and shows its source in the formula bar", async () => {
  api.table.mockResolvedValue(tableOf("a2", 2));
  api.listVersions.mockResolvedValue([ver("a2", 2)]);
  const view = await mount(<SheetView artifact={artifact} />);
  const bar = () => view.querySelector('[data-testid="formula-bar"]')?.textContent;
  await mouse(at(view, 2, 2), "mousedown");
  expect(bar()).toBe("48000");
  await key(grid(view), "ArrowDown");
  expect(bar()).toBe("=SUM(C2:C3)");
  await key(grid(view), "ArrowLeft");
  expect(bar()).toBe("");
});

const formatted = () => {
  const table = tableOf("a2", 2);
  const sheet = table.sheets[0] as (typeof table.sheets)[0] & { colWidths?: number[] };
  const rows = sheet.rows as Array<Array<Record<string, unknown>>>;
  (rows[1] as Array<Record<string, unknown>>)[2] = { ...cell(64000), z: "$#,##0.00" };
  (rows[2] as Array<Record<string, unknown>>)[1] = {
    v: "2024-03-01T00:00:00",
    f: null,
    t: "d",
    z: "mmm d, yyyy",
  };
  sheet.colWidths = [10, 30, 12];
  return table;
};

it("shows numbers and dates through their format, but the formula bar and editor keep the raw value", async () => {
  api.table.mockResolvedValue(formatted());
  api.listVersions.mockResolvedValue([ver("a2", 2)]);
  const view = await mount(<SheetView artifact={artifact} />);

  expect(at(view, 1, 2).textContent).toBe("$64,000.00");
  expect(at(view, 2, 1).textContent).toBe("Mar 1, 2024");
  expect(at(view, 2, 1).className).toContain("text-right");

  await mouse(at(view, 1, 2), "mousedown");
  expect(view.querySelector('[data-testid="formula-bar"]')?.textContent).toBe("64000");
  await mouse(at(view, 2, 1), "mousedown");
  expect(view.querySelector('[data-testid="formula-bar"]')?.textContent).toBe(
    "2024-03-01T00:00:00",
  );

  await act(async () => button(view, /^Edit$/).click());
  await mouse(at(view, 1, 2), "mousedown");
  await key(grid(view), "Enter");
  expect((view.querySelector("input") as HTMLInputElement).value).toBe("64000");
});

it("sizes columns from the file's widths", async () => {
  api.table.mockResolvedValue(formatted());
  api.listVersions.mockResolvedValue([ver("a2", 2)]);
  const view = await mount(<SheetView artifact={artifact} />);
  const cols = [...view.querySelectorAll("colgroup col")].map(
    (c) => (c as HTMLElement).style.width,
  );
  expect(cols).toEqual(["48px", "108px", "260px", "124px"]);
  // A cell that may be clipped carries its full value as a tooltip.
  expect(at(view, 2, 1).title).toBe("Mar 1, 2024");
});

it("keeps the number format on an edited cell and the date type on an undone date", async () => {
  const after = formatted();
  (after.sheets[0]?.rows[2]?.[1] as { v: string }).v = "2025-01-15T00:00:00";
  api.table.mockImplementation(async ({ artifactId }: { artifactId: string }) =>
    artifactId === "a3" ? { ...after, artifactId: "a3", version: 3 } : formatted(),
  );
  api.listVersions
    .mockResolvedValueOnce([ver("a2", 2)])
    .mockResolvedValue([ver("a3", 3, { origin: "manual", parentVersionId: "a2" }), ver("a2", 2)]);
  api.editTable.mockResolvedValue({ id: "a3", version: 3 });
  const view = await mount(<SheetView artifact={artifact} />);
  await act(async () => button(view, /^Edit$/).click());
  await mouse(at(view, 2, 1), "mousedown");
  await key(grid(view), "Enter");
  const input = view.querySelector("input") as HTMLInputElement;
  await type(input, "2025-01-15T00:00:00");
  await key(input, "Enter");
  expect(at(view, 2, 1).textContent).toBe("Jan 15, 2025");
  expect(api.editTable.mock.calls[0]?.[0].edits).toEqual([
    { sheet: "Sales", row: 2, col: 1, value: "2025-01-15T00:00:00" },
  ]);
  await tick();
  // Undo sends the old value back as the ISO text it was read as; the engine keeps it a date.
  await act(async () => button(view, /^Undo$/).click());
  expect(api.editTable.mock.calls[1]?.[0].edits).toEqual([
    { sheet: "Sales", row: 2, col: 1, value: "2024-03-01T00:00:00" },
  ]);
});

it("has one Undo, in the changes strip", async () => {
  api.table.mockImplementation(async ({ artifactId }: { artifactId: string }) =>
    artifactId === "a3" ? tableOf("a3", 3, 1) : tableOf("a2", 2),
  );
  api.listVersions
    .mockResolvedValueOnce([ver("a2", 2)])
    .mockResolvedValue([ver("a3", 3, { origin: "manual", parentVersionId: "a2" }), ver("a2", 2)]);
  api.editTable.mockResolvedValue({ id: "a3", version: 3 });
  const view = await mount(<SheetView artifact={artifact} />);
  await act(async () => button(view, /^Edit$/).click());
  await mouse(at(view, 1, 2), "mousedown");
  await key(grid(view), "Enter");
  await type(view.querySelector("input") as HTMLInputElement, "1");
  await key(view.querySelector("input") as HTMLInputElement, "Enter");
  await tick();
  const undos = [...view.querySelectorAll("button")].filter((b) =>
    /^Undo$/.test(b.textContent ?? ""),
  );
  expect(undos).toHaveLength(1);
  expect(view.querySelector('[data-testid="sheet-changes"]')?.contains(undos[0] as Node)).toBe(
    true,
  );
});

it("puts Edit in the host it is given instead of its own row", async () => {
  api.table.mockResolvedValue(tableOf("a2", 2));
  api.listVersions.mockResolvedValue([ver("a2", 2)]);
  const host = document.createElement("div");
  document.body.append(host);
  const view = await mount(<SheetView artifact={artifact} toolbarHost={host} />);
  expect(button(view, /^Edit$/)).toBeUndefined();
  expect(host.querySelector("button")?.textContent).toBe("Edit");
});
