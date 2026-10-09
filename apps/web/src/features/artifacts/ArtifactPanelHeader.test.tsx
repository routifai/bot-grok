// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, type ComponentProps, cloneElement, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ getById: vi.fn(), listVersions: vi.fn() }));
vi.mock("../../lib/rpc", () => ({ rpc: { artifacts: api } }));
vi.mock("./Artifacts", () => ({ ArtifactPreview: () => <div data-testid="body" /> }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...v: unknown[]) =>
      parts.reduce((out, part, i) => out + part + (v[i] ?? ""), ""),
  }),
}));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
  plural: (n: number, forms: { one: string; other: string }) =>
    (n === 1 ? forms.one : forms.other).replace("#", String(n)),
}));
vi.mock("@nova/ui-web", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@nova/ui-web")>();
  const Passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ...actual,
    DropdownMenu: Passthrough,
    DropdownMenuContent: Passthrough,
    DropdownMenuItem: ({ children, onClick }: ComponentProps<"button">) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
    DropdownMenuTrigger: ({ render, children }: { render?: ReactElement; children?: ReactNode }) =>
      render ? (
        cloneElement(render, undefined, children)
      ) : (
        <button type="button">{children}</button>
      ),
  };
});

import { ArtifactPanel } from "./ArtifactPanel";
import { type ArtifactExtension, ArtifactRegistryProvider } from "./registry";

i18n.loadAndActivate({ locale: "en", messages: {} });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  api.getById.mockReset();
  api.listVersions.mockReset();
  document.body.innerHTML = "";
});

const quiet: ArtifactExtension = {
  usePanel: ({ artifact }) =>
    artifact?.name === "d.deck.html"
      ? { hideDefaults: true, actions: <i data-testid="mine" />, overflow: <b>Publish…</b> }
      : {},
  card: () => null,
};

async function open(name: string) {
  api.listVersions.mockResolvedValue([]);
  api.getById.mockResolvedValue({
    id: "a1",
    name,
    mimeType: "text/html",
    contentBase64: btoa("<p>x</p>"),
  });
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () =>
    createRoot(container).render(
      <I18nProvider i18n={i18n}>
        <ArtifactRegistryProvider value={[quiet]}>
          <ArtifactPanel artifactId="a1" onClose={() => {}} />
        </ArtifactRegistryProvider>
      </I18nProvider>,
    ),
  );
  await act(async () => {});
  return container;
}
const labels = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("button, a")).map(
    (e) => e.getAttribute("aria-label") ?? e.textContent,
  );

it("keeps today's header for an ordinary page", async () => {
  const c = await open("page.html");
  expect(labels(c)).toEqual(
    expect.arrayContaining(["Open full screen", "Download", "Open in new tab", "Close"]),
  );
  expect(c.querySelector('[data-testid="panel-overflow"]')).toBeNull();
});

it("drops the default buttons for a deck and shows the overflow menu", async () => {
  const c = await open("d.deck.html");
  const found = labels(c);
  expect(found).not.toContain("Open full screen");
  expect(found).not.toContain("Download");
  expect(found).not.toContain("Open in new tab");
  expect(found).toContain("Close");
  expect(c.querySelector('[data-testid="mine"]')).not.toBeNull();
  expect(c.querySelector('[data-testid="panel-overflow"]')).not.toBeNull();
  expect(c.textContent).toContain("Publish…");
});
