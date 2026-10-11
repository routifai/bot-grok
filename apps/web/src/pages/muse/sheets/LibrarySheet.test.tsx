// @vitest-environment jsdom
// A file opened from the Library sheet replaces the grid in the same sheet: one frame (never a
// dialog over the sheet), "‹ Library" and Escape go back to the grid with its filter kept, and a
// deck is edited right there (the selection reaches the inspector and the ask box).

import type { DeckEditTarget } from "@superchat/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../../test/i18n")).withI18nRoot(
    await orig<typeof import("react-dom/client")>(),
  ),
);

const DECK_ID = "deck-v1";
const api = vi.hoisted(() => ({
  listVersions: vi.fn(),
  getById: vi.fn(),
  listSpace: vi.fn(),
}));
vi.mock("../../../lib/rpc", () => ({ rpc: { artifacts: api, decks: {}, chats: {} } }));
vi.mock("../../../lib/family-stream", () => ({ watchFamily: () => () => {} }));

import { artifactKey, setArtifactEditing } from "../../../features/artifacts/editor/editor-state";
import { ArtifactRegistryProvider } from "../../../features/artifacts/registry";
import { decksExtension } from "../../../features/decks";
import { FIXTURE_DECK } from "../../../features/decks/deck-fixture";
import { resetDeckUi } from "../../../features/decks/deck-ui-state";
import { LibrarySheet } from "./DockSheets";

const NAME = "tea.deck.html";
const title: DeckEditTarget = {
  id: "cover-title",
  kind: "text",
  tag: "h1",
  slide: 1,
  text: "Tea",
  editable: true,
  rect: { x: 0, y: 0, w: 100, h: 50 },
  inline: {},
  computed: { "font-size": "64px" },
  href: null,
  alt: null,
};
const deck = {
  id: DECK_ID,
  botId: "bot-1",
  runId: null,
  name: NAME,
  description: "Tea",
  mimeType: "text/html",
  size: FIXTURE_DECK.length,
  version: 1,
  createdAt: "2026-01-01T00:00:00Z",
  publish: null,
};

let root: Root;
let host: HTMLElement;
const onClose = vi.fn();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.listSpace.mockResolvedValue({ items: [{ ...deck, versionCount: 1 }], nextCursor: null });
  api.listVersions.mockResolvedValue([
    { id: DECK_ID, version: 1, name: NAME, createdAt: "2026-01-01T00:00:00Z" },
  ]);
  api.getById.mockResolvedValue({
    ...deck,
    contentBase64: Buffer.from(FIXTURE_DECK, "utf8").toString("base64"),
  });
  onClose.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  resetDeckUi();
  document.body.innerHTML = "";
});

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const pressEscape = () =>
  act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });

async function openFromLibrary() {
  await act(async () =>
    root.render(
      <ArtifactRegistryProvider value={[decksExtension]}>
        <LibrarySheet
          botId="bot-1"
          open
          onClose={onClose}
          onNewApp={() => {}}
          onSendIdea={() => {}}
        />
      </ArtifactRegistryProvider>,
    ),
  );
  await settle();
  const open = document.querySelector('[aria-label="Open Tea"]') as HTMLElement;
  expect(open).not.toBeNull();
  await act(async () => open.click());
  await settle();
}

it("opens a file in the sheet itself: one frame, its title, and ‹ Library back to the grid", async () => {
  await openFromLibrary();
  // One window: the sheet, with the editor inside it; no dialog over it.
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  const sheet = document.querySelector('[data-testid="dock-sheet"]') as HTMLElement;
  expect(sheet.querySelector('[data-testid="artifact-editor"]')).not.toBeNull();
  expect(sheet.querySelector('[data-testid="artifact-editor-title"]')?.textContent).toBe("Tea");
  // Only the editor's close shows; the grid is hidden, not gone.
  expect(sheet.querySelectorAll('[aria-label="Close"]')).toHaveLength(1);
  expect(
    sheet.querySelector('[data-testid="library-embedded"]')?.closest(".hidden"),
  ).not.toBeNull();

  await act(async () =>
    (document.querySelector('[data-testid="library-back"]') as HTMLElement).click(),
  );
  expect(document.querySelector('[data-testid="artifact-editor"]')).toBeNull();
  expect(document.querySelector('[aria-label="Open Tea"]')).not.toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});

it("Escape goes back to the grid first, then closes the sheet", async () => {
  await openFromLibrary();
  await pressEscape();
  expect(document.querySelector('[data-testid="artifact-editor"]')).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  await pressEscape();
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("edits a deck in the sheet: the selection reaches the inspector and the ask box", async () => {
  await openFromLibrary();
  await act(async () => setArtifactEditing(artifactKey({ botId: "bot-1", name: NAME }), true));

  const frame = document.querySelector(
    '[data-testid="deck-edit-frame"] iframe',
  ) as HTMLIFrameElement;
  expect(frame).not.toBeNull();
  const nonce = /NONCE = \\"([0-9a-f]{32})\\"/.exec(frame.getAttribute("srcdoc") ?? "")?.[1];
  const send = (msg: Record<string, unknown>) =>
    act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { v: 1, nonce, ...msg },
          source: frame.contentWindow as Window,
        }),
      );
    });
  await send({ type: "superchat:edit-ready", theme: { colors: [], fonts: [], slideCount: 1 } });
  expect(document.querySelector('[data-testid="deck-style-empty"]')).not.toBeNull();
  await send({ type: "superchat:edit-selection", targets: [title] });

  expect(document.querySelector('[data-testid="deck-style-empty"]')).toBeNull();
  expect(document.querySelector('[data-testid="deck-style-panel"]')?.textContent).toContain(
    "cover-title",
  );
  const chips = [...document.querySelectorAll('[data-testid="ask-chip"]')];
  expect(chips.map((chip) => chip.textContent)).toEqual(["h1 · cover-title"]);
});
