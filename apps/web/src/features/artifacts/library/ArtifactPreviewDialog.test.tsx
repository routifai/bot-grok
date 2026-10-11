// @vitest-environment jsdom
// A deck opened from the Library sheet: the preview dialog over the sheet edits it in place. The
// selection reaches the inspector and the ask box there, and only one close button shows.

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
}));
vi.mock("../../../lib/rpc", () => ({ rpc: { artifacts: api, decks: {}, chats: {} } }));
vi.mock("../../../lib/family-stream", () => ({ watchFamily: () => () => {} }));

import { DockSheet } from "../../../pages/muse/chrome/DockSheet";
import { decksExtension } from "../../decks";
import { FIXTURE_DECK } from "../../decks/deck-fixture";
import { resetDeckUi, setDeckEditing } from "../../decks/deck-ui-state";
import { ArtifactRegistryProvider } from "../registry";
import { ArtifactPreviewDialog } from "./ArtifactPreviewDialog";

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

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.listVersions.mockResolvedValue([
    { id: DECK_ID, version: 1, name: NAME, createdAt: "2026-01-01T00:00:00Z" },
  ]);
  api.getById.mockResolvedValue({
    id: DECK_ID,
    botId: "bot-1",
    groupId: null,
    runId: null,
    name: NAME,
    description: "Tea",
    mimeType: "text/html",
    size: FIXTURE_DECK.length,
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
    publish: null,
    contentBase64: Buffer.from(FIXTURE_DECK, "utf8").toString("base64"),
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  resetDeckUi();
  document.body.innerHTML = "";
});

it("edits a deck in the Library preview: the selection reaches the inspector and the ask box", async () => {
  await act(async () =>
    root.render(
      <ArtifactRegistryProvider value={[decksExtension]}>
        <DockSheet open title="Library" onClose={() => {}}>
          <ArtifactPreviewDialog artifactId={DECK_ID} onOpenChange={() => {}} />
        </DockSheet>
      </ArtifactRegistryProvider>,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => setDeckEditing(NAME, true));

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

  // One close: the sheet's own close hides while the preview dialog is open over it.
  const sheet = document.querySelector('[data-testid="dock-sheet"]') as HTMLElement;
  expect(sheet.hasAttribute("data-nested-dialog-open")).toBe(true);
  const sheetClose = [...sheet.children].find(
    (el) => el.tagName === "BUTTON" && el.getAttribute("aria-label") === "Close",
  );
  expect(sheetClose?.className).toContain("[[data-nested-dialog-open]>&]:hidden");
});
