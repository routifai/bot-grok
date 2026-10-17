// @vitest-environment jsdom
// A file's studio (ADR 0024): opened from the panel's Edit or by typing in its ask box, it sends
// to the file's own chat, takes no hand edits while a studio turn runs, and closes on back or
// Escape. Files the editor cannot show keep today's panel.

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { FamilyEvent } from "@superchat/contracts";
import type { ReactNode } from "react";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getById: vi.fn(),
  listVersions: vi.fn(),
  restore: vi.fn(),
  chat: vi.fn(),
  chatOpen: vi.fn(async () => ({ sessionId: "studio-1", warm: true })),
}));
const chats = vi.hoisted(() => ({
  send: vi.fn(async (_input: { botId: string; chatId?: string; text: string }) => ({
    ok: true as const,
  })),
  interrupt: vi.fn(async () => ({ delivered: true })),
  transcript: vi.fn(),
  watchStatus: vi.fn(
    async (
      _input: { botId: string; chatId: string },
      _options: { signal: AbortSignal },
    ): Promise<AsyncIterable<{ status: string; blockedOn: string | null }>> => statusFeed(),
  ),
}));
/** The studio session's status frames, pushed by a test. */
const status = vi.hoisted(() => ({
  push: (_frame: { status: string; blockedOn: string | null }) => {},
}));
async function* statusFeed() {
  const queue: { status: string; blockedOn: string | null }[] = [];
  let wake: (() => void) | null = null;
  status.push = (frame) => {
    queue.push(frame);
    wake?.();
  };
  while (true) {
    const next = queue.shift();
    if (next) yield next;
    else await new Promise<void>((resolve) => (wake = resolve));
  }
}
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
import { OPEN_SIGNAL_MS } from "./useStudioChat";

i18n.loadAndActivate({ locale: "en", messages: {} });

/** What the fake deck has selected on its canvas when it opens (its ask box's chips). */
const selection = vi.hoisted(() => ({ chips: [] as { id: string; label: string }[] }));
function useFakeDeck({ editing, locked }: { editing: boolean; locked: boolean }) {
  const [chips, setChips] = useState(selection.chips);
  return {
    label: "Deck",
    editable: true,
    stage: (
      <div data-testid="stage" data-locked={locked ? "true" : undefined}>
        {editing ? "editing" : "viewing"}
      </div>
    ),
    inspector: <div data-testid="inspector" />,
    ask: {
      chips,
      onRemoveChip: (id: string) => setChips((now) => now.filter((chip) => chip.id !== id)),
      placeholder: "Ask superchat to change this file…",
      contextBlock: () => "",
    },
  };
}
const deckKind: ArtifactEditorKind = { id: "deck", useEditor: useFakeDeck };
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

/** This browser's storage (the "since you were here" mark). */
const stored = new Map<string, string>();
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  });
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }),
  );
  api.listVersions.mockResolvedValue([]);
  api.chat.mockResolvedValue({ sessionId: "studio-1", created: false });
  chats.transcript.mockResolvedValue({ threadId: "studio-1", messages: [], olderCursor: null });
  chats.watchStatus.mockImplementation(async () => statusFeed());
  api.chatOpen.mockResolvedValue({ sessionId: "studio-1", warm: true });
});
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.unstubAllGlobals();
  for (const fn of [...Object.values(api), ...Object.values(chats)]) fn.mockReset();
  family.listeners.clear();
  resetEditorState();
  selection.chips = [];
  stored.clear();
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

/** Escape where the person is (the focused control), as a keyboard sends it. */
const pressEscape = () =>
  act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });

async function openDeck(opener?: HTMLElement) {
  api.getById.mockResolvedValue(file("v1", "mock_markets.deck.html", "text/html", "<p>x</p>"));
  const view = await mount(<ArtifactPanel artifactId="v1" opener={opener} onClose={() => {}} />);
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
  // The canvas is lit, inert and saves nothing; the next request can still be typed.
  expect(sheet.querySelector('[data-testid="studio-working"]')).not.toBeNull();
  expect(sheet.querySelector('[data-slot="editor-canvas"]')?.hasAttribute("inert")).toBe(true);
  expect(sheet.querySelector('[data-testid="stage"]')?.getAttribute("data-locked")).toBe("true");
  expect(sheet.querySelector('[data-testid="inspector"]')).toBeNull();
  expect(box.disabled).toBe(false);
  // A turn of the Conversation does not end it; the studio's own does.
  await emit({ type: "turnDone", chatId: "bot-1", status: "completed" });
  expect(sheet.querySelector('[data-testid="studio-working"]')).not.toBeNull();
  await emit({ type: "turnDone", chatId: "studio-1", status: "completed" });
  expect(sheet.querySelector('[data-testid="studio-working"]')).toBeNull();
  expect(sheet.querySelector('[data-slot="editor-canvas"]')?.hasAttribute("inert")).toBe(false);
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
    "superchat is updating this file…",
  );
});

it("names the slide being changed when the request was about one", async () => {
  chats.transcript.mockResolvedValue({
    threadId: "studio-1",
    messages: [
      said(
        "m1",
        "user",
        '<superchat-element-request file="d.deck.html" artifact="v1" version="1" slide="3" chip="Slide 3">\nHard scope.\n</superchat-element-request>\n\nShorter',
        1,
      ),
    ],
    olderCursor: null,
    running: true,
  });
  await openDeck();
  expect(studio()?.querySelector('[data-testid="studio-working"]')?.textContent).toContain(
    "superchat is updating slide 3…",
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
  await pressEscape();
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

it("hands off from the panel only once an input method's composition ends", async () => {
  api.getById.mockResolvedValue(file("v1", "mock_markets.deck.html", "text/html", "<p>x</p>"));
  const view = await mount(<ArtifactPanel artifactId="v1" onClose={() => {}} />);
  const panelBox = view.querySelector(
    'textarea[aria-label="Ask superchat"]',
  ) as HTMLTextAreaElement;
  await act(async () => {
    panelBox.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  });
  await type(panelBox, "に");
  expect(studio()).toBeNull();
  await type(panelBox, "日本");
  expect(studio()).toBeNull();
  await act(async () => {
    panelBox.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本" }));
  });
  await tick();
  const box = studio()?.querySelector(
    'textarea[aria-label="Ask superchat"]',
  ) as HTMLTextAreaElement;
  expect(box.value).toBe("日本");
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
  expect(api.chatOpen).not.toHaveBeenCalled();
});

function said(id: string, role: "user" | "bot" | "system", text: string, minute: number) {
  return {
    id,
    threadId: "studio-1",
    seq: minute,
    role,
    blocks: [{ kind: "text" as const, text }],
    createdAt: new Date(Date.UTC(2026, 9, 17, 10, minute)).toISOString(),
  };
}

const notice = (id: string, minute: number, block: Record<string, unknown>) => ({
  ...said(id, "system", "", minute),
  blocks: [{ kind: "notice", ...block }],
});

it("words the engine's notices itself: a save elsewhere, and a hand edit in plain words", async () => {
  chats.transcript.mockResolvedValue({
    threadId: "studio-1",
    messages: [
      said("m1", "user", "Biggest first", 1),
      notice("n1", 2, { notice: "stale", version: 9, origin: "superchat" }),
      said("a1", "bot", "Sorted the bars.", 3),
      notice("h1", 4, {
        notice: "hand_edit",
        version: 2,
        elementId: "cover-title",
        element: "the title",
        what: "You made the title larger",
      }),
    ],
    olderCursor: null,
  });
  await openDeck();
  expect(studio()?.querySelector('[data-testid="studio-note"]')?.textContent).toBe(
    "Super Chat saved v9 while you were editing",
  );
  expect(studio()?.querySelector('[data-testid="studio-hand-edit"]')?.textContent).toBe(
    "You made the title larger",
  );
});

it("marks the versions saved since the last visit, and remembers this one", async () => {
  stored.set("superchat.studio.seen.group-1", "1");
  const version = (n: number, minute: number) => ({
    id: `v${n}`,
    version: n,
    name: "mock_markets.deck.html",
    createdAt: new Date(Date.UTC(2026, 9, 17, 10, minute)).toISOString(),
    origin: "ai",
    chatId: "bot-1",
  });
  api.listVersions.mockResolvedValue([version(2, 5), version(1, 0)]);
  await openDeck();
  const rows = [...(studio()?.querySelectorAll('[data-testid="studio-thread"] > *') ?? [])];
  const kinds = rows.map((row) => row.getAttribute("data-testid"));
  expect(kinds).toEqual(["studio-version", "studio-since", "studio-version"]);
  expect(rows[0]?.textContent).toContain("From Super Chat");
  expect(stored.get("superchat.studio.seen.group-1")).toBe("2");
});

it("puts the engine's words on the composer's line while a studio turn waits for a slot", async () => {
  await openDeck();
  const line = () => studio()?.querySelector('[data-testid="ask-status"]')?.textContent ?? "";
  expect(chats.watchStatus).toHaveBeenCalledWith(
    { botId: "bot-1", chatId: "studio-1" },
    expect.anything(),
  );
  await act(async () =>
    status.push({ status: "running", blockedOn: "Finishing another file first" }),
  );
  expect(line()).toContain("Finishing another file first");
  await act(async () => status.push({ status: "running", blockedOn: null }));
  expect(line()).not.toContain("Finishing another file first");
});

it("tells the engine the studio is open, every five minutes while it stays open", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const view = await openDeck();
    expect(api.chatOpen).toHaveBeenCalledTimes(1);
    expect(api.chatOpen).toHaveBeenCalledWith({ artifactId: "v1" });
    await act(async () => vi.advanceTimersByTime(OPEN_SIGNAL_MS));
    expect(api.chatOpen).toHaveBeenCalledTimes(2);
    await act(async () =>
      (studio() as HTMLElement).querySelector<HTMLElement>('[data-testid="studio-back"]')?.click(),
    );
    expect(view.querySelector('[data-testid="artifact-panel"]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(OPEN_SIGNAL_MS * 2));
    expect(api.chatOpen).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it("stacks on a phone: the canvas, then the composer, which opens the chat as a sheet", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(max-width: 639px)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  await openDeck();
  const sheet = studio() as HTMLElement;
  expect(sheet.dataset.layout).toBe("phone");
  expect(sheet.querySelector('[data-slot="editor-body"]')?.className).toContain("flex-col");
  const sheetOpen = () => document.querySelector('[data-testid="studio-chat-sheet"]');
  expect(sheetOpen()).toBeNull();
  // The composer under the canvas opens the chat over it, with the thread and the ask box.
  await act(async () =>
    (sheet.querySelector('[data-testid="studio-chat-open"]') as HTMLElement).click(),
  );
  expect(sheetOpen()?.querySelector('[data-testid="studio-thread"]')).not.toBeNull();
  const box = sheetOpen()?.querySelector("textarea") as HTMLTextAreaElement;
  await type(box, "Shorter");
  // Its back control closes it and leaves the studio open; what was typed is still there.
  await act(async () =>
    (
      document.querySelector('[data-testid="studio-chat-sheet"] [aria-label="Back"]') as HTMLElement
    ).click(),
  );
  await tick();
  expect(sheetOpen()).toBeNull();
  expect(studio()).not.toBeNull();
  await act(async () =>
    (sheet.querySelector('[data-testid="studio-chat-open"]') as HTMLElement).click(),
  );
  expect(
    document.querySelector<HTMLTextAreaElement>('[data-testid="studio-chat-sheet"] textarea')
      ?.value,
  ).toBe("Shorter");
  // Escape closes the sheet first, then the studio.
  await pressEscape();
  await tick();
  expect(sheetOpen()).toBeNull();
  expect(studio()).not.toBeNull();
});

it("keeps the side-by-side layout wider than a phone", async () => {
  await openDeck();
  const sheet = studio() as HTMLElement;
  expect(sheet.dataset.layout).toBe("wide");
  const chat = sheet.querySelector('[data-testid="studio-chat"]') as HTMLElement;
  expect(chat.querySelector('[data-testid="studio-thread"]')).not.toBeNull();
});

it("Escape keeps the studio while something is selected, then closes it and hands focus back to the file card", async () => {
  const card = document.createElement("button");
  card.textContent = "Open";
  document.body.append(card);
  selection.chips = [{ id: "title", label: "Slide 1 · title" }];
  await openDeck(card);
  expect(studio()?.getAttribute("role")).toBe("dialog");
  const back = studio()?.querySelector('[data-testid="studio-back"]');
  expect(back?.getAttribute("aria-label")).toBe("Back to Super Chat");

  await pressEscape();
  expect(studio()).not.toBeNull();

  // Nothing selected any more (the chip's remove, as clicking the canvas away would do).
  await act(async () =>
    studio()?.querySelector<HTMLElement>('[aria-label="Remove Slide 1 · title"]')?.click(),
  );
  await pressEscape();
  await tick();
  expect(studio()).toBeNull();
  expect(document.activeElement).toBe(card);
});

it("Escape closes an open menu before the studio", async () => {
  const version = (n: number) => ({
    id: `v${n}`,
    version: n,
    name: "mock_markets.deck.html",
    createdAt: "2026-10-17T10:00:00Z",
    origin: "ai",
    chatId: "bot-1",
  });
  api.listVersions.mockResolvedValue([version(2), version(1)]);
  await openDeck();
  const trigger = studio()?.querySelector('[data-testid="version-menu"]') as HTMLElement;
  await act(async () => trigger.click());
  await tick();
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  await pressEscape();
  await tick();
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(studio()).not.toBeNull();
});

it("re-reads the chat on a timer only while a turn runs and its stream is down", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    await openDeck();
    const reads = () => chats.transcript.mock.calls.length;
    const before = reads();
    // Nothing running: no polling.
    await act(async () => vi.advanceTimersByTime(9000));
    expect(reads()).toBe(before);
    // Running with the stream up: the stream says when it ends.
    await act(async () => status.push({ status: "running", blockedOn: null }));
    await act(async () => vi.advanceTimersByTime(9000));
    expect(reads()).toBe(before);
  } finally {
    vi.useRealTimers();
  }
});

it("polls a running turn while the session's stream is down", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    chats.watchStatus.mockImplementation(async () => {
      throw new Error("down");
    });
    chats.transcript.mockResolvedValue({
      threadId: "studio-1",
      messages: [],
      olderCursor: null,
      running: true,
    });
    await openDeck();
    const before = chats.transcript.mock.calls.length;
    await act(async () => vi.advanceTimersByTime(3000));
    expect(chats.transcript.mock.calls.length).toBeGreaterThan(before);
  } finally {
    vi.useRealTimers();
  }
});
