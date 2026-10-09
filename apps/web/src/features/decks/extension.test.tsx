// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { Artifact } from "@nova/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ export: vi.fn(), getById: vi.fn() }));
const download = vi.hoisted(() => vi.fn());
vi.mock("../../lib/rpc", () => ({ rpc: { decks: api, artifacts: api } }));
vi.mock("../../lib/artifact-open", () => ({
  decodeArtifactBase64: () => new Uint8Array([1]),
  downloadArtifactBytes: download,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...v: unknown[]) =>
      parts.reduce((out, part, i) => out + part + (v[i] ?? ""), ""),
  }),
}));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...v: unknown[]) =>
    parts.reduce((out, part, i) => out + part + (v[i] ?? ""), ""),
}));

import { FIXTURE_DECK } from "./deck-fixture";
import { decksExtension } from "./extension";

i18n.loadAndActivate({ locale: "en", messages: {} });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  download.mockReset();
  document.body.innerHTML = "";
});

const file = (name: string, mimeType = "text/html"): Artifact =>
  ({ id: `id-${name}`, name, mimeType }) as Artifact;
const deck = file("launch.deck.html");

function Panel({ artifact }: { artifact: Artifact }) {
  const parts = decksExtension.usePanel({ artifact });
  return (
    <div>
      {parts.actions}
      {parts.below}
    </div>
  );
}

async function mount(artifact: Artifact) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <I18nProvider i18n={i18n}>
        <Panel artifact={artifact} />
      </I18nProvider>,
    ),
  );
  return container;
}
const buttonText = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("button")).map((b) => b.textContent);

it("views and badges only decks", () => {
  const bytes = new TextEncoder().encode(FIXTURE_DECK);
  const fallback = null;
  expect(decksExtension.view?.({ artifact: file("page.html"), bytes, fallback })).toBeNull();
  expect(decksExtension.view?.({ artifact: deck, bytes, fallback })).not.toBeNull();
  expect(decksExtension.card(file("page.html"))).toBeNull();
  expect(decksExtension.card(deck)).toEqual({ meta: "Slide deck" });
});

it("offers the export buttons for a deck only", async () => {
  expect(buttonText(await mount(file("page.html")))).toEqual([]);
  expect(buttonText(await mount(deck))).toEqual(["Export to PowerPoint", "Export to PDF"]);
});

it("exports in the chosen format, shows progress and then the new file", async () => {
  let finish: (value: Artifact) => void = () => {};
  api.export.mockReturnValue(new Promise<Artifact>((resolve) => (finish = resolve)));
  api.getById.mockResolvedValue({ name: "launch.pptx", mimeType: "x", contentBase64: "AQ==" });
  const c = await mount(deck);
  const [pptx, pdf] = Array.from(c.querySelectorAll("button"));

  await act(async () => pptx?.click());
  await act(async () => pptx?.click());
  expect(api.export).toHaveBeenCalledTimes(1);
  expect(api.export).toHaveBeenCalledWith({ artifactId: "id-launch.deck.html", format: "pptx" });
  expect(buttonText(c)[0]).toBe("Preparing PowerPoint…");
  expect((pdf as HTMLButtonElement).disabled).toBe(true);
  expect(c.querySelector('[data-testid="deck-export-status"]')?.textContent).toContain(
    "PowerPoint",
  );

  await act(async () => finish(file("launch.pptx", "application/x")));
  const status = c.querySelector('[data-testid="deck-export-status"]') as HTMLElement;
  expect(status.textContent).toContain("launch.pptx is ready");
  const get = Array.from(status.querySelectorAll("button")).find(
    (b) => b.textContent === "Download",
  );
  await act(async () => get?.click());
  expect(download).toHaveBeenCalledWith("launch.pptx", "x", expect.any(Uint8Array));
});

it("sends pdf for the PDF button and says calmly when it fails", async () => {
  api.export.mockRejectedValue(new Error("engine exploded: stack trace"));
  const c = await mount(deck);
  await act(async () => (c.querySelectorAll("button")[1] as HTMLButtonElement).click());
  expect(api.export).toHaveBeenCalledWith({ artifactId: "id-launch.deck.html", format: "pdf" });
  const text = c.querySelector('[data-testid="deck-export-status"]')?.textContent ?? "";
  expect(text).toContain("Couldn't prepare the PDF");
  expect(text).not.toContain("stack trace");
  expect((c.querySelectorAll("button")[1] as HTMLButtonElement).disabled).toBe(false);
});
