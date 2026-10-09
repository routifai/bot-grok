// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...v: unknown[]) =>
      parts.reduce((out, part, i) => out + part + (v[i] ?? ""), ""),
  }),
}));

import { DeckRail } from "./DeckRail";
import { FIXTURE_DECK } from "./deck-fixture";
import { parseDeckSlides } from "./deck-model";

i18n.loadAndActivate({ locale: "en", messages: {} });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  document.body.innerHTML = "";
});

async function mount(slim: boolean, onSelect = vi.fn()) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <I18nProvider i18n={i18n}>
        <DeckRail
          html={FIXTURE_DECK}
          slides={parseDeckSlides(FIXTURE_DECK)}
          active={0}
          onSelect={onSelect}
          slim={slim}
        />
      </I18nProvider>,
    ),
  );
  return container;
}
const rail = (c: HTMLElement) => c.querySelector('[data-testid="deck-rail"]') as HTMLElement;

it("is the plain rail in view mode, with no toggle", async () => {
  const c = await mount(false);
  expect(rail(c).dataset.slim).toBeUndefined();
  expect(c.querySelector('button[aria-label="Expand slides"]')).toBeNull();
  expect(c.querySelectorAll('[role="option"]')).toHaveLength(3);
});

it("is a slim strip in edit mode that opens on hover and on the toggle", async () => {
  const onSelect = vi.fn();
  const c = await mount(true, onSelect);
  expect(rail(c).dataset.slim).toBe("true");
  expect(rail(c).dataset.open).toBeUndefined();

  await act(async () => rail(c).dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  expect(rail(c).dataset.open).toBe("true");
  await act(async () => rail(c).dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
  expect(rail(c).dataset.open).toBeUndefined();

  const toggle = c.querySelector('button[aria-label="Expand slides"]') as HTMLButtonElement;
  await act(async () => toggle.click());
  expect(rail(c).dataset.open).toBe("true");
  await act(async () =>
    (c.querySelector('button[aria-label="Collapse slides"]') as HTMLButtonElement).click(),
  );
  expect(rail(c).dataset.open).toBeUndefined();

  await act(async () => (c.querySelectorAll('[role="option"]')[1] as HTMLButtonElement).click());
  expect(onSelect).toHaveBeenCalledWith(1);
});

it("shows each slide's number in the slim strip, the current one emphasised", async () => {
  const c = await mount(true);
  const numbers = Array.from(c.querySelectorAll('[role="option"]')).map(
    (o) => o.querySelector("span.tabular-nums")?.textContent,
  );
  expect(numbers).toEqual(["1", "2", "3"]);
  expect(
    c.querySelector('[role="option"][aria-selected="true"] span.tabular-nums')?.className,
  ).toContain("font-semibold");
});
