// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getById: vi.fn(),
  listVersions: vi.fn(),
  publish: vi.fn(),
  unpublish: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    artifacts: { getById: api.getById, listVersions: api.listVersions },
    apps: { publish: api.publish, unpublish: api.unpublish },
  },
}));
vi.mock("../artifacts/Artifacts", () => ({
  ArtifactPreview: ({ bytes }: { bytes: Uint8Array }) => (
    <div data-testid="body">{new TextDecoder().decode(bytes)}</div>
  ),
}));
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

import { ArtifactRegistryProvider } from "../artifacts";
import { ArtifactPanel } from "../artifacts/ArtifactPanel";
import { ArtifactPreviewDialog } from "../artifacts/library/ArtifactPreviewDialog";
import { appsExtension } from "./extension";

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
  api.publish.mockReset();
  api.unpublish.mockReset();
  document.body.innerHTML = "";
});

const b64 = (text: string) => btoa(text);
const tick = () => act(async () => {});

async function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <I18nProvider i18n={i18n}>
        <ArtifactRegistryProvider value={[appsExtension]}>{node}</ArtifactRegistryProvider>
      </I18nProvider>,
    ),
  );
  return container;
}

const htmlArtifact = (publish: unknown = null) => ({
  id: "h1",
  name: "todo.html",
  mimeType: "text/html",
  version: 3,
  contentBase64: b64("<p>hi</p>"),
  publish,
});
const byText = (root: ParentNode, text: string) =>
  [...root.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent?.trim() === text);

it("publishes an app from the panel: dialog, audience, then the Published bar", async () => {
  api.listVersions.mockResolvedValue([{ id: "h1", version: 3, name: "todo.html", createdAt: "" }]);
  api.getById.mockResolvedValue(htmlArtifact());
  api.publish.mockResolvedValue({
    slug: "todo-k3m9xq",
    urlPath: "/apps/todo-k3m9xq",
    audience: "link",
    version: 3,
    publishedAt: "",
    stats: { opensTotal: 14, uniqueViewers: 5, opens7d: 9 },
  });
  api.unpublish.mockResolvedValue({ ok: true });
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const view = await mount(<ArtifactPanel artifactId="h1" title="Todo" onClose={() => {}} />);
  await tick();
  expect(view.querySelector("[data-testid=published-pill]")).toBeNull();
  expect(byText(view, "Open full screen")).toBeTruthy();

  await act(async () => byText(view, "Publish…")?.click());
  const dialog = document.querySelector("[data-testid=publish-dialog]") as HTMLElement;
  expect(dialog.textContent).toContain("Publish Todo?");
  expect(dialog.textContent).toContain(
    "It gets its own web address. It runs on its own, separate from Nova, and can't see your conversations or files.",
  );
  for (const label of ["Only me", "My organization", "Anyone with the link"]) {
    expect(dialog.textContent).toContain(label);
  }
  const radios = [...dialog.querySelectorAll<HTMLElement>("[role=radio]")];
  expect(radios).toHaveLength(3);
  await act(async () => radios[2]?.click());
  await act(async () => byText(dialog, "Publish")?.click());
  await tick();
  expect(api.publish).toHaveBeenCalledWith({ artifactId: "h1", audience: "link", version: 3 });
  expect(document.querySelector("[data-testid=publish-dialog]")).toBeNull();
  expect(view.querySelector("[data-testid=published-pill]")?.textContent).toBe("Published");
  const bar = view.querySelector("[data-testid=published-bar]") as HTMLElement;
  expect(bar.textContent).toContain(`${window.location.origin}/apps/todo-k3m9xq`);
  expect(bar.textContent).toContain("Anyone with the link · 14 opens · 5 viewers");
  expect(byText(view, "Publish settings")).toBeTruthy();

  await act(async () => byText(bar, "Copy link")?.click());
  expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/apps/todo-k3m9xq`);

  await act(async () => byText(bar, "Unpublish")?.click());
  const confirm = document.querySelector("[role=alertdialog]") as HTMLElement;
  expect(confirm.textContent).toContain("Unpublish this app?");
  await act(async () => byText(confirm, "Unpublish")?.click());
  await tick();
  expect(api.unpublish).toHaveBeenCalledWith({ artifactId: "h1" });
  expect(view.querySelector("[data-testid=published-bar]")).toBeNull();
  expect(view.querySelector("[data-testid=published-pill]")).toBeNull();
});

it("a non-app file offers no publish controls", async () => {
  api.listVersions.mockResolvedValue([]);
  api.getById.mockResolvedValue({
    id: "m1",
    name: "n.md",
    mimeType: "text/markdown",
    version: 1,
    contentBase64: b64("x"),
  });
  const view = await mount(<ArtifactPanel artifactId="m1" onClose={() => {}} />);
  await tick();
  expect(byText(view, "Publish…")).toBeUndefined();
  expect(byText(view, "Open full screen")).toBeUndefined();
});

const libraryArtifact = (mimeType: string, name: string, publish: unknown = null) => ({
  id: "a1",
  name,
  mimeType,
  version: 3,
  contentBase64: b64("x"),
  publish,
});
const dialogButtons = () => [...document.querySelectorAll<HTMLElement>("button")];
const dialogByText = (text: string) => dialogButtons().find((b) => b.textContent?.trim() === text);

it("the Library dialog offers Publish and full screen for an HTML artifact", async () => {
  api.listVersions.mockResolvedValue([{ id: "a1", version: 3, name: "dog.html", createdAt: "" }]);
  api.getById.mockResolvedValue(libraryArtifact("text/html", "dog.html"));
  await mount(<ArtifactPreviewDialog artifactId="a1" onOpenChange={() => {}} />);
  await tick();
  expect(dialogByText("Publish…")).toBeTruthy();
  expect(dialogByText("Open full screen")).toBeTruthy();
  expect(dialogByText("Download")).toBeTruthy();
});

it("the Library dialog shows the Published bar for a published app", async () => {
  api.listVersions.mockResolvedValue([]);
  api.getById.mockResolvedValue(
    libraryArtifact("text/html", "dog.html", {
      slug: "dog-k3m9xq",
      urlPath: "/apps/dog-k3m9xq",
      audience: "link",
      version: 3,
      publishedAt: "",
      stats: { opensTotal: 14, uniqueViewers: 5, opens7d: 9 },
    }),
  );
  await mount(<ArtifactPreviewDialog artifactId="a1" onOpenChange={() => {}} />);
  await tick();
  expect(document.querySelector("[data-testid=published-bar]")?.textContent).toContain("14 opens");
  expect(dialogByText("Publish settings")).toBeTruthy();
});

it("the Library dialog offers no Publish for a non-HTML artifact", async () => {
  api.listVersions.mockResolvedValue([]);
  api.getById.mockResolvedValue(libraryArtifact("text/markdown", "n.md"));
  await mount(<ArtifactPreviewDialog artifactId="a1" onOpenChange={() => {}} />);
  await tick();
  expect(dialogByText("Download")).toBeTruthy();
  expect(dialogByText("Publish…")).toBeUndefined();
  expect(dialogByText("Open full screen")).toBeUndefined();
});
