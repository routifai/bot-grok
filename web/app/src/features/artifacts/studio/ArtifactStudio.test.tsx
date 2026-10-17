// @vitest-environment jsdom
// A file's studio (ADR 0024): opened from the panel's Edit or by typing in its ask box, it sends
// to the file's own chat, takes no hand edits while a studio turn runs, and closes on back or
// Escape. Files the editor cannot show keep today's panel.

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { FamilyEvent } from "@superchat/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getById: vi.fn(),
  listVersions: vi.fn(),
  restore: vi.fn(),
  chat: vi.fn(),
}));
const chats = vi.hoisted(() => ({
  send: vi.fn(async (_input: { botId: string; chatId?: string; text: string }) => ({
    ok: true as const,
  })),
  interrupt: vi.fn(async () => ({ ok: true as const })),
  transcript: vi.fn(),
}));
const family = vi.hoisted(() => ({ listeners: new Set<(event: FamilyEvent) => void>() }));
vi.mock("../../../lib/rpc", () => ({ rpc: { artifacts: api, chats } }));
vi.mock("../../../lib/family-stream", () => ({
  watchFamily: (_botId: string, listener: (event: FamilyEvent) => void) => {
    family.listeners.add(listener);
    return () => family.listeners.delete(listener);
  },
}));
vi.mock("../ArtifactPreview", () => ({
  ArtifactPreview: ({ bytes }: { bytes: Uint8Array }) => (
    <div data-testid="body">{new TextDecoder().decode(bytes)}</div>
  ),
}));
vi.mock("../../../components/ai/orb", () => ({ SuperchatOrb: () => <span data-testid="orb" /> }));
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
import { resetEditorState } from "../editor/editor-state";
import type { ArtifactEditorKind, ArtifactExtension } from "../registry";
import { ArtifactRegistryProvider } from "../registry";

i18n.loadAndActivate({ locale: "en", messages: {} });

const deckKind: ArtifactEditorKind = {
  id: "deck",
  useEditor: ({ editing }) => ({
    label: "Deck",
    editable: true,
    stage: <div data-testid="stage">{editing ? "editing" : "viewing"}</div>,
    inspector: <div data-testid="inspector" />,
    ask: { chips: [], placeholder: "Ask superchat to change this file…", contextBlock: () => "" },
  }),
};
const decks: ArtifactExtension = {
  usePanel: () => ({}),
  card: () => null,
  editor: (artifact) => (artifact.name.endsWith(".deck.html") ? deckKind : null),
};

const file = (id: string, name: string, mimeType: string, text: string) => ({
  id,
  name,
  mimeType,
  botId: "bot-1",
  runId: null,
  description: null,
  size: text.length,
  version: 1,
  createdAt: "",
  publish: null,
  groupId: "group-1",
  contentBase64: btoa(text),
});

const emit = (event: FamilyEvent) =>
  act(async () => {
    for (const listener of [...family.listeners]) listener(event);
  });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }),
  );
  api.listVersions.mockResolvedValue([]);
  api.chat.mockResolvedValue({ sessionId: "studio-1", created: false });
  chats.transcript.mockResolvedValue({ threadId: "studio-1", messages: [], olderCursor: null });
});
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.unstubAllGlobals();
  for (const fn of [...Object.values(api), ...Object.values(chats)]) fn.mockReset();
  family.listeners.clear();
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
        <ArtifactRegistryProvider value={[decks]}>{node}</ArtifactRegistryProvider>
      </I18nProvider>,
    ),
  );
  await tick();
  return container;
}

const studio = () => document.querySelector<HTMLElement>('[data-testid="artifact-studio"]');

async function type(box: HTMLTextAreaElement, text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(box, text);
    box.setSelectionRange(text.length, text.length);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openDeck() {
  api.getById.mockResolvedValue(file("v1", "mock_markets.deck.html", "text/html", "<p>x</p>"));
  const view = await mount(<ArtifactPanel artifactId="v1" onClose={() => {}} />);
  await act(async () => (view.querySelector('[data-testid="editor-edit"]') as HTMLElement).click());
  await tick();
  return view;
}

it("sends to the file's studio chat, not the Conversation, and is read-only while its turn runs", async () => {
  await openDeck();
  const sheet = studio() as HTMLElement;
  expect(sheet.querySelector('[data-testid="studio-chat"]')?.textContent).toContain(
    "This file's chat",
  );
  expect(chats.transcript).toHaveBeenCalledWith({ botId: "bot-1", chatId: "studio-1" });
  expect(sheet.querySelector('[data-testid="inspector"]')).not.toBeNull();
  const box = sheet.querySelector('textarea[aria-label="Ask superchat"]') as HTMLTextAreaElement;
  await type(box, "Make this a bar chart, biggest first.");
  await act(async () => (sheet.querySelector('[aria-label="Send"]') as HTMLElement).click());
  expect(chats.send).toHaveBeenCalledWith({
    botId: "bot-1",
    chatId: "studio-1",
    text: "Make this a bar chart, biggest first.",
  });
  // The canvas is lit and takes no hand edits; the next request can still be typed.
  expect(sheet.querySelector('[data-testid="studio-working"]')).not.toBeNull();
  expect(sheet.querySelector('[data-testid="inspector"]')).toBeNull();
  expect(box.disabled).toBe(false);
  // A turn of the Conversation does not end it; the studio's own does.
  await emit({ type: "turnDone", chatId: "bot-1", status: "completed" });
  expect(sheet.querySelector('[data-testid="studio-working"]')).not.toBeNull();
  await emit({ type: "turnDone", chatId: "studio-1", status: "completed" });
  expect(sheet.querySelector('[data-testid="studio-working"]')).toBeNull();
  expect(sheet.querySelector('[data-testid="inspector"]')).not.toBeNull();
});

it("a studio turn running in another tab locks the canvas too", async () => {
  chats.transcript.mockResolvedValue({
    threadId: "studio-1",
    messages: [],
    olderCursor: null,
    running: true,
  });
  await openDeck();
  expect(studio()?.querySelector('[data-testid="studio-working"]')?.textContent).toContain(
    "superchat is updating this slide…",
  );
});

it("back and Escape close the studio; the panel stays open on the file", async () => {
  const view = await openDeck();
  const back = studio()?.querySelector('[aria-label="Back to Super Chat"]') as HTMLElement;
  expect(back.textContent).toContain("Super Chat");
  await act(async () => back.click());
  expect(studio()).toBeNull();
  expect(view.querySelector('[data-testid="artifact-panel"]')).not.toBeNull();

  await act(async () => (view.querySelector('[data-testid="editor-edit"]') as HTMLElement).click());
  await tick();
  expect(studio()).not.toBeNull();
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(studio()).toBeNull();
  expect(view.querySelector('[data-testid="artifact-panel"]')).not.toBeNull();
});

it("typing in the panel's ask box opens the studio with the words and the caret", async () => {
  api.getById.mockResolvedValue(file("v1", "mock_markets.deck.html", "text/html", "<p>x</p>"));
  const view = await mount(<ArtifactPanel artifactId="v1" onClose={() => {}} />);
  const panelBox = view.querySelector(
    'textarea[aria-label="Ask superchat"]',
  ) as HTMLTextAreaElement;
  await type(panelBox, "M");
  await tick();
  const sheet = studio() as HTMLElement;
  const box = sheet.querySelector('textarea[aria-label="Ask superchat"]') as HTMLTextAreaElement;
  expect(box.value).toBe("M");
  expect(box.selectionStart).toBe(1);
  expect(chats.send).not.toHaveBeenCalled();
});

it.each([
  ["report.pdf", "application/pdf", "%PDF"],
  ["deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "PK"],
])("%s has no Edit and no studio: its panel asks Super Chat as today", async (name, mime, body) => {
  api.getById.mockResolvedValue(file("p1", name, mime, body));
  const view = await mount(<ArtifactPanel artifactId="p1" onClose={() => {}} />);
  expect(view.querySelector('[data-testid="editor-edit"]')).toBeNull();
  const box = view.querySelector('textarea[aria-label="Ask superchat"]') as HTMLTextAreaElement;
  await type(box, "Make it one page");
  expect(studio()).toBeNull();
  expect(box.value).toBe("Make it one page");
  expect(api.chat).not.toHaveBeenCalled();
});
