// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((acc, part, i) => `${acc}${part}${values[i] ?? ""}`, ""),
  }),
}));
vi.mock("@aiden/ui-web", async () => {
  const actual = await vi.importActual<typeof import("@aiden/ui-web")>("@aiden/ui-web");
  return {
    ...actual,
    BotAvatar: ({ museState }: { museState?: string }) => (
      <div data-testid="welcome-avatar" data-muse-state={museState} />
    ),
  };
});

import { FirstRunWelcome } from "./FirstRunWelcome";

let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  if (container) {
    document.body.removeChild(container);
    container = null;
  }
  vi.unstubAllGlobals();
});

function renderWelcome() {
  container = document.createElement("div");
  document.body.appendChild(container);
  return createRoot(container);
}

it("greets the person by name and starts with a brief wave", async () => {
  const root = renderWelcome();
  await act(async () => {
    root.render(
      <FirstRunWelcome
        botName="Aiden"
        personName="Sam"
        avatarColor="#4C8BF5"
        onTryIt={() => undefined}
        onDismiss={() => undefined}
      />,
    );
  });

  expect(container?.textContent).toContain("Hi Sam, I'm Aiden");
  expect(
    container?.querySelector("[data-testid='welcome-avatar']")?.getAttribute("data-muse-state"),
  ).toBe("waiting");
  // All three cards render, each with its own "Try it".
  const tryItChips = Array.from(container?.querySelectorAll("button") ?? []).filter(
    (button) => button.textContent === "Try it",
  );
  expect(tryItChips).toHaveLength(3);
});

it("fills the composer with a card's example instead of sending it", async () => {
  const seen: string[] = [];
  const root = renderWelcome();
  await act(async () => {
    root.render(
      <FirstRunWelcome
        botName="Aiden"
        personName="Sam"
        avatarColor="#4C8BF5"
        onTryIt={(text) => seen.push(text)}
        onDismiss={() => undefined}
      />,
    );
  });

  const chips = container?.querySelectorAll("button");
  const tryItChip = Array.from(chips ?? []).find((button) => button.textContent === "Try it");
  expect(tryItChip).toBeTruthy();

  await act(async () => {
    tryItChip?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

  expect(seen).toHaveLength(1);
  expect(seen[0]).toContain("rate-change news");
});

it("dismisses without requiring a message to be sent", async () => {
  let dismissed = false;
  const root = renderWelcome();
  await act(async () => {
    root.render(
      <FirstRunWelcome
        botName="Aiden"
        personName=""
        avatarColor="#4C8BF5"
        onTryIt={() => undefined}
        onDismiss={() => {
          dismissed = true;
        }}
      />,
    );
  });

  expect(container?.textContent).toContain("Hi, I'm Aiden");

  const dismissButton = container?.querySelector("button[aria-label]");
  await act(async () => {
    dismissButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(dismissed).toBe(true);
});
