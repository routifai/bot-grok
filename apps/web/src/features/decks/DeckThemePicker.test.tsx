// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { DeckTheme } from "@nova/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...v: unknown[]) =>
      parts.reduce((out, part, i) => out + part + (v[i] ?? ""), ""),
  }),
}));

import { DeckThemePicker, resetDeckThemeCache } from "./DeckThemePicker";
import { readDeckThemeName } from "./deck-model";
import { resetDeckUi, setDeckThemeOpen, useDeckThemeOpen } from "./deck-ui-state";

i18n.loadAndActivate({ locale: "en", messages: {} });

const THEMES: DeckTheme[] = [
  {
    id: "corporate-clean",
    name: "Corporate Clean",
    mood: "White and navy.",
    category: "professional",
    mode: "light",
    bestFor: "reports",
    preview: "data:image/webp;base64,AA==",
  },
  {
    id: "nord",
    name: "Nord",
    mood: "Arctic dark slate.",
    category: "dark",
    mode: "dark",
    bestFor: "long reviews",
    preview: "data:image/webp;base64,AA==",
  },
];
const DECK = `<style>\n    /* Corporate Clean · layout vocabulary and theme */\n.a{}</style>`;
const KEY = "q3.deck.html";

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetDeckThemeCache();
});
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  resetDeckUi();
});

async function mount(over: { editSource?: ReturnType<typeof vi.fn>; onEdited?: () => void } = {}) {
  const editSource = over.editSource ?? vi.fn(async () => ({ id: "v2", version: 2 }));
  const onEdited = over.onEdited ?? vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  function Probe() {
    return <span data-testid="open">{String(useDeckThemeOpen(KEY))}</span>;
  }
  const render = (html: string, version: number) =>
    act(async () =>
      root.render(
        <I18nProvider i18n={i18n}>
          <Probe />
          <DeckThemePicker
            deckKey={KEY}
            html={html}
            artifact={{ id: `v${version}`, version }}
            onEdited={onEdited}
            themesSource={async () => ({ themes: THEMES, defaultTheme: "corporate-clean" })}
            editSource={editSource as never}
          />
        </I18nProvider>,
      ),
    );
  await render(DECK, 1);
  return { container, editSource, onEdited, render };
}
const card = (c: HTMLElement, id: string) =>
  c.querySelector(`[data-testid="deck-theme-${id}"]`) as HTMLButtonElement;

it("reads the theme name from the deck's style block", () => {
  expect(readDeckThemeName(DECK)).toBe("Corporate Clean");
  expect(readDeckThemeName("<html></html>")).toBeNull();
});

it("shows every theme with its thumbnail and mood, grouped, the current one marked", async () => {
  const { container } = await mount();
  expect(container.querySelectorAll('[role="radio"]')).toHaveLength(2);
  expect(card(container, "corporate-clean").getAttribute("aria-checked")).toBe("true");
  expect(card(container, "nord").getAttribute("aria-checked")).toBe("false");
  expect(card(container, "nord").textContent).toContain("Arctic dark slate.");
  expect(card(container, "nord").querySelector("img")?.getAttribute("src")).toContain("data:image");
  expect(Array.from(container.querySelectorAll("h3")).map((h) => h.textContent)).toEqual([
    "Professional",
    "Dark",
  ]);
});

it("picking a theme sends one set-theme patch on the shown version, and Undo puts the source back", async () => {
  const { container, editSource, onEdited, render } = await mount();
  await act(async () => card(container, "nord").click());
  expect(editSource).toHaveBeenCalledWith({
    artifactId: "v1",
    baseVersion: 1,
    patches: [{ kind: "set-theme", theme: "nord" }],
  });
  expect(onEdited).toHaveBeenCalledWith("v2");
  // the panel adopts the new version
  const NORD = DECK.replace("Corporate Clean", "Nord");
  await render(NORD, 2);
  expect(card(container, "nord").getAttribute("aria-checked")).toBe("true");
  expect(container.textContent).toContain("Switched to Nord");
  const undo = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "Undo",
  ) as HTMLButtonElement;
  await act(async () => undo.click());
  expect(editSource).toHaveBeenLastCalledWith({
    artifactId: "v2",
    baseVersion: 2,
    patches: [{ kind: "set-full-source", source: DECK }],
  });
});

it("says what went wrong and keeps the gallery when the engine refuses", async () => {
  const editSource = vi.fn(async () => {
    throw new Error("This deck's theme can't be swapped exactly; ask Nova to restyle it");
  });
  const { container } = await mount({ editSource });
  await act(async () => card(container, "nord").click());
  expect(container.querySelector('[role="status"]')?.textContent).toContain("ask Nova");
  expect(card(container, "nord").getAttribute("aria-checked")).toBe("false");
});

it("closes on Escape and on a click outside, not on a click inside", async () => {
  const { container } = await mount();
  await act(async () => setDeckThemeOpen(KEY, true));
  const open = () => container.querySelector('[data-testid="open"]')?.textContent;
  await act(async () =>
    container
      .querySelector("h3")
      ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })),
  );
  expect(open()).toBe("true");
  await act(async () =>
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })),
  );
  expect(open()).toBe("false");
  await act(async () => setDeckThemeOpen(KEY, true));
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(open()).toBe("false");
});
