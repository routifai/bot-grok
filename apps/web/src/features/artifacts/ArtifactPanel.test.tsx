// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getById: vi.fn(),
  listVersions: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({ rpc: { artifacts: api } }));
vi.mock("./Artifacts", () => ({
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

import { ArtifactPanelProvider, ReplyCardThreadProvider } from "../../components/cards/context";
import { ArtifactPanel } from "./ArtifactPanel";
import { ArtifactFileCard } from "./cards/ArtifactFileCard";

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

it("says Exported by you on a file the person delivered, and only then", async () => {
  api.getById.mockResolvedValue({ id: "a1", name: "q3.pptx", mimeType: "x", contentBase64: "" });
  const data = { name: "q3.pptx", artifactId: "a1", kind: "pptx", size: 2048 };
  const view = await mount(
    <ArtifactPanelProvider value={{ openId: null, open: () => {}, close: () => {} }}>
      <ReplyCardThreadProvider messages={[] as never}>
        <div data-testid="mine">
          <ArtifactFileCard data={{ ...data, byYou: true }} />
        </div>
        <div data-testid="muse">
          <ArtifactFileCard data={data} />
        </div>
      </ReplyCardThreadProvider>
    </ArtifactPanelProvider>,
  );
  expect(view.querySelector("[data-testid=mine]")?.textContent).toContain("Exported by you");
  expect(view.querySelector("[data-testid=muse]")?.textContent).not.toContain("Exported by you");
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
