// @vitest-environment jsdom
// The one artifact editor shell: the header (title, version menu with restore, Edit, `⋯`), the
// edit toolbar and inspector only in edit mode, and the ask box for every kind, editable or not.

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getById: vi.fn(),
  listVersions: vi.fn(),
  restore: vi.fn(),
}));
const chats = vi.hoisted(() => ({
  send: vi.fn(async (_input: { botId: string; text: string }) => ({ ok: true as const })),
  interrupt: vi.fn(),
  transcript: vi.fn(),
}));
vi.mock("../../../lib/rpc", () => ({ rpc: { artifacts: api, chats } }));
vi.mock("../../../lib/family-stream", () => ({ watchFamily: () => () => {} }));
vi.mock("../Artifacts", () => ({
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
  t: (parts: TemplateStringsArray, ...v: unknown[]) =>
    parts.reduce((out, part, i) => out + part + (v[i] ?? ""), ""),
}));

import { ArtifactPanel } from "../ArtifactPanel";
import {
  type ArtifactEditorKind,
  type ArtifactExtension,
  ArtifactRegistryProvider,
} from "../registry";
import { artifactKey, resetEditorState, setArtifactEditing } from "./editor-state";

i18n.loadAndActivate({ locale: "en", messages: {} });

const undo = vi.fn(async () => {});
const calls: string[] = [];
const flush = vi.fn(async () => {
  calls.push("flush");
});
const fakeKind: ArtifactEditorKind = {
  id: "fake",
  useEditor: ({ editing }) => ({
    label: "Page",
    editable: true,
    stage: <div data-testid="stage">{editing ? "editing" : "viewing"}</div>,
    inspector: <div data-testid="inspector" />,
    history: {
      canUndo: true,
      canRedo: false,
      saving: false,
      undo,
      redo: async () => {},
      flush,
      expectAsk: () => {},
      headVersion: () => 0,
    },
    ask: { chips: [], placeholder: "Ask about the page", contextBlock: () => "PAGE-BLOCK" },
  }),
};
const pages: ArtifactExtension = {
  usePanel: () => ({}),
  card: () => null,
  editor: (artifact) => (artifact.name.endsWith(".html") ? fakeKind : null),
};

const file = (id: string, name: string, mimeType: string, text: string) => ({
  id,
  name,
  mimeType,
  botId: "bot-1",
  groupId: null,
  runId: null,
  description: name === "tracker.html" ? "Expense tracker" : null,
  size: text.length,
  version: Number(id.slice(1)) || 1,
  createdAt: "",
  publish: null,
  contentBase64: btoa(text),
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }),
  );
});
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.unstubAllGlobals();
  for (const fn of [...Object.values(api), ...Object.values(chats), undo, flush]) fn.mockClear();
  calls.length = 0;
  api.getById.mockReset();
  api.listVersions.mockReset();
  api.restore.mockReset();
  resetEditorState();
  document.body.innerHTML = "";
});

const tick = () => act(async () => {});

async function mount(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <I18nProvider i18n={i18n}>
        <ArtifactRegistryProvider value={[pages]}>{node}</ArtifactRegistryProvider>
      </I18nProvider>,
    ),
  );
  await tick();
  return container;
}

async function openMenu(root: ParentNode, selector: string) {
  const trigger = root.querySelector(selector) as HTMLElement;
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    trigger.click();
  });
}
const menuItems = (testId: string) => [
  ...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
];
const button = (root: ParentNode, text: string) =>
  [...root.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent?.trim() === text);

it("shows the file's title, and the version menu says who made each version and restores one", async () => {
  api.listVersions.mockResolvedValue([
    { id: "v3", version: 3, name: "tracker.html", createdAt: "", origin: "restore" },
    { id: "v2", version: 2, name: "tracker.html", createdAt: "", origin: "manual" },
    { id: "v1", version: 1, name: "tracker.html", createdAt: "", origin: "ai" },
  ]);
  api.getById.mockImplementation(async ({ artifactId }: { artifactId: string }) =>
    file(artifactId, "tracker.html", "text/html", `<p>${artifactId}</p>`),
  );
  const view = await mount(<ArtifactPanel artifactId="v3" onClose={() => {}} />);
  const heading = view.querySelector('[data-testid="artifact-editor-title"]') as HTMLElement;
  expect(heading.textContent).toBe("Expense tracker");
  expect(heading.title).toBe("tracker.html");
  expect(view.querySelector('[data-testid="version-menu"]')?.textContent).toContain(
    "Page · version 3",
  );

  await openMenu(view, '[data-testid="version-menu"]');
  expect(menuItems("version-item").map((item) => item.textContent)).toEqual([
    expect.stringContaining("Version 3 · latest"),
    expect.stringContaining("Version 2"),
    expect.stringContaining("Version 1"),
  ]);
  expect(menuItems("version-item")[0]?.textContent).toContain("restored");
  expect(menuItems("version-item")[1]?.textContent).toContain("by you");
  expect(menuItems("version-item")[2]?.textContent).toContain("by superchat");
  // The newest is on screen: nothing to restore.
  expect(menuItems("version-restore")).toEqual([]);
  await act(async () => menuItems("version-item")[2]?.click());
  await tick();
  expect(view.querySelector('[data-testid="version-menu"]')?.textContent).toContain(
    "Page · version 1",
  );

  api.restore.mockResolvedValue(file("v4", "tracker.html", "text/html", "<p>v1</p>"));
  api.listVersions.mockResolvedValue([
    { id: "v4", version: 4, name: "tracker.html", createdAt: "", origin: "restore" },
    { id: "v3", version: 3, name: "tracker.html", createdAt: "", origin: "restore" },
    { id: "v2", version: 2, name: "tracker.html", createdAt: "", origin: "manual" },
    { id: "v1", version: 1, name: "tracker.html", createdAt: "", origin: "ai" },
  ]);
  await openMenu(view, '[data-testid="version-menu"]');
  await act(async () => menuItems("version-restore")[0]?.click());
  await tick();
  expect(api.restore).toHaveBeenCalledWith({ artifactId: "v1" });
  expect(api.getById).toHaveBeenLastCalledWith({ artifactId: "v4" });
  expect(view.querySelector('[data-testid="version-menu"]')?.textContent).toContain(
    "Page · version 4",
  );
});

it("restoring saves what is staged by hand first, then restores", async () => {
  api.listVersions.mockResolvedValue([
    { id: "v2", version: 2, name: "tracker.html", createdAt: "", origin: "manual" },
    { id: "v1", version: 1, name: "tracker.html", createdAt: "", origin: "ai" },
  ]);
  api.getById.mockImplementation(async ({ artifactId }: { artifactId: string }) =>
    file(artifactId, "tracker.html", "text/html", `<p>${artifactId}</p>`),
  );
  api.restore.mockImplementation(async () => {
    calls.push("restore");
    return file("v3", "tracker.html", "text/html", "<p>v1</p>");
  });
  const view = await mount(<ArtifactPanel artifactId="v2" onClose={() => {}} />);
  await openMenu(view, '[data-testid="version-menu"]');
  await act(async () => menuItems("version-item")[1]?.click());
  await tick();
  await openMenu(view, '[data-testid="version-menu"]');
  await act(async () => menuItems("version-restore")[0]?.click());
  await tick();
  expect(api.restore).toHaveBeenCalledWith({ artifactId: "v1" });
  expect(calls).toEqual(["flush", "restore"]);
});

it("Edit turns on the toolbar and the inspector; Done turns them off; one undo for both", async () => {
  api.listVersions.mockResolvedValue([]);
  api.getById.mockResolvedValue(file("v1", "tracker.html", "text/html", "<p>x</p>"));
  const view = await mount(<ArtifactPanel artifactId="v1" onClose={() => {}} />);
  const edit = view.querySelector('[data-testid="editor-edit"]') as HTMLElement;
  expect(edit.getAttribute("aria-pressed")).toBe("false");
  expect(view.querySelector('[data-testid="stage"]')?.textContent).toBe("viewing");
  expect(view.querySelector('[data-testid="editor-toolbar"]')).toBeNull();
  expect(view.querySelector('[data-testid="editor-inspector"]')).toBeNull();

  await act(async () => edit.click());
  expect(edit.getAttribute("aria-pressed")).toBe("true");
  expect(view.querySelector('[data-testid="stage"]')?.textContent).toBe("editing");
  expect(view.querySelector('[data-testid="editor-toolbar"]')).not.toBeNull();
  expect(view.querySelector('[data-testid="editor-inspector"]')).not.toBeNull();
  // The panel takes the room it can while a file is edited.
  expect(view.querySelector('[data-testid="artifact-panel"]')?.className).toContain(
    "md:w-[min(84vw,1600px)]",
  );
  await act(async () => (view.querySelector('[aria-label="Undo"]') as HTMLElement).click());
  expect(undo).toHaveBeenCalledTimes(1);

  await act(async () => button(view, "Done")?.click());
  expect(view.querySelector('[data-testid="editor-toolbar"]')).toBeNull();
  expect(view.querySelector('[data-testid="stage"]')?.textContent).toBe("viewing");
  await act(async () =>
    setArtifactEditing(artifactKey({ botId: "bot-1", name: "tracker.html" }), true),
  );
  expect(view.querySelector('[data-testid="stage"]')?.textContent).toBe("editing");
});

it("a file without an editor opens read-only, with the ask box about the whole file", async () => {
  api.listVersions.mockResolvedValue([]);
  api.getById.mockResolvedValue(file("p1", "report.pdf", "application/pdf", "%PDF"));
  const view = await mount(<ArtifactPanel artifactId="p1" onClose={() => {}} />);
  expect(view.querySelector('[data-testid="body"]')?.textContent).toBe("%PDF");
  expect(view.querySelector('[data-testid="editor-edit"]')).toBeNull();
  expect(view.querySelector('[data-testid="version-label"]')?.textContent).toBe("PDF · version 1");
  expect(view.querySelector('[aria-label="Download"]')).not.toBeNull();

  const box = view.querySelector('textarea[aria-label="Ask superchat"]') as HTMLTextAreaElement;
  expect(box.placeholder).toBe("Ask superchat to change this file…");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(box, "Make it one page");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => (view.querySelector('[aria-label="Send"]') as HTMLElement).click());
  expect(chats.send).toHaveBeenCalledTimes(1);
  const text = chats.send.mock.calls[0]?.[0].text ?? "";
  expect(text).toContain('file="report.pdf" artifact="p1" version="1" chip="Whole file"');
  expect(text.endsWith("\n\nMake it one page")).toBe(true);
});

it.each([
  ["tracker.html", "text/html", false],
  ["deck.slides.html", "text/html", false],
  ["logo.svg", "image/svg+xml", false],
  ["report.pdf", "application/pdf", true],
  ["photo.png", "image/png", true],
])("%s opens in a new tab: %s", async (name, mimeType, opens) => {
  // A blob: URL in its own tab runs at the app's origin, so nothing that can script goes there.
  api.listVersions.mockResolvedValue([]);
  api.getById.mockResolvedValue(file("v1", name, mimeType, "x"));
  const view = await mount(<ArtifactPanel artifactId="v1" onClose={() => {}} />);
  await openMenu(view, '[data-testid="panel-overflow"]');
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(items.length).toBeGreaterThan(0);
  expect(items.some((item) => item.textContent?.trim() === "Open in new tab")).toBe(opens);
});
