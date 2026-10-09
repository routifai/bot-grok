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
vi.mock("../lib/rpc", () => ({ rpc: { artifacts: api } }));
vi.mock("../pages/Artifacts", () => ({
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

import { ArtifactPanel } from "./ArtifactPanel";
import { ArtifactFileCard } from "./cards/ArtifactFileCard";
import { ArtifactPanelProvider, ReplyCardThreadProvider } from "./cards/context";

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
  await act(async () => root.render(<I18nProvider i18n={i18n}>{node}</I18nProvider>));
  return container;
}

it("closes on Escape and the close button, and switches versions in place", async () => {
  api.listVersions.mockResolvedValue([
    { id: "a2", version: 2, name: "p.html", createdAt: "" },
    { id: "a1", version: 1, name: "p.html", createdAt: "" },
  ]);
  api.getById.mockImplementation(async ({ artifactId }: { artifactId: string }) => ({
    id: artifactId,
    name: "p.html",
    mimeType: "text/markdown",
    contentBase64: b64(artifactId === "a2" ? "second" : "first"),
  }));
  const onClose = vi.fn();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const view = await mount(<ArtifactPanel artifactId="a1" title="Plan" onClose={onClose} />);
  await tick();
  expect(view.textContent).toContain("Plan");
  expect(view.querySelector("[data-testid=body]")?.textContent).toBe("second");
  const picker = view.querySelector("select") as HTMLSelectElement;
  await act(async () => {
    picker.value = "a1";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await tick();
  expect(view.querySelector("[data-testid=body]")?.textContent).toBe("first");
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  expect(onClose).toHaveBeenCalledTimes(1);
  await act(async () => (view.querySelector("[aria-label=Close]") as HTMLElement).click());
  expect(onClose).toHaveBeenCalledTimes(2);
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
});

const fileBlock = (id: string, artifactId: string, version: number) => ({
  kind: "reply_card" as const,
  card: "file",
  id,
  data: { name: "p.html", artifactId, version, versions: version },
  fallback: "",
});

it("marks the earlier card Updated and opens the panel on Expand", async () => {
  const open = vi.fn();
  const messages = [
    { id: "m1", role: "assistant", blocks: [fileBlock("f1", "a1", 1)] },
    { id: "m2", role: "assistant", blocks: [fileBlock("f2", "a2", 2)] },
  ] as never;
  const view = await mount(
    <ArtifactPanelProvider value={{ openId: null, open, close: () => {} }}>
      <ReplyCardThreadProvider messages={messages}>
        <ArtifactFileCard title="Plan" data={fileBlock("f1", "a1", 1).data} />
        <ArtifactFileCard title="Plan" data={fileBlock("f2", "a2", 2).data} />
      </ReplyCardThreadProvider>
    </ArtifactPanelProvider>,
  );
  const chip = view.querySelector("[data-testid=artifact-updated]") as HTMLElement;
  expect(chip.textContent).toBe("Updated — v2");
  expect(view.querySelectorAll("[data-testid=artifact-version]")).toHaveLength(1);
  await act(async () => chip.click());
  expect(open).toHaveBeenCalledWith("a2", "Plan");
  await act(async () =>
    (view.querySelectorAll("[aria-label^='Expand']")[1] as HTMLElement).click(),
  );
  expect(open).toHaveBeenLastCalledWith("a2", "Plan");
});

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

it("full screen toggles the panel and Escape leaves it before closing", async () => {
  api.listVersions.mockResolvedValue([]);
  api.getById.mockResolvedValue(
    htmlArtifact({
      slug: "s-abc123",
      urlPath: "/apps/s-abc123",
      audience: "org",
      version: 3,
      publishedAt: "",
      stats: { opensTotal: 1, uniqueViewers: 1, opens7d: 1 },
    }),
  );
  const onClose = vi.fn();
  const view = await mount(<ArtifactPanel artifactId="h1" onClose={onClose} />);
  await tick();
  expect(view.querySelector("[data-testid=published-pill]")).toBeTruthy();
  const panel = view.querySelector("[data-testid=artifact-panel]") as HTMLElement;
  expect(panel.className).toContain("md:relative");
  await act(async () => byText(view, "Open full screen")?.click());
  expect(panel.className).not.toContain("md:relative");
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  expect(onClose).not.toHaveBeenCalled();
  expect(panel.className).toContain("md:relative");
});
