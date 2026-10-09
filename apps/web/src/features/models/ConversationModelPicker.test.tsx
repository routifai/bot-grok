// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../test/i18n")).withI18nRoot(await orig<typeof import("react-dom/client")>()),
);
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((acc, part, i) => `${acc}${part}${values[i] ?? ""}`, "");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});

const state = vi.hoisted(() => ({
  status: { enabled: true } as { enabled: boolean } | null,
  sessionModel: vi.fn(),
  setSessionModel: vi.fn(),
}));
vi.mock("./engine-models", () => ({
  useEngineModelsStatus: () => [state.status, () => undefined, true],
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    engineModels: { sessionModel: state.sessionModel, setSessionModel: state.setSessionModel },
  },
}));
vi.mock("../../components/ai/orb", () => ({ NovaOrb: () => null, useOrbHome: () => false }));

import { ConversationModelPicker } from "./ConversationModelPicker";

const catalog = {
  harness: "pi",
  status: "ready",
  providerLabel: "Anthropic",
  defaultModel: "sonnet-5",
  error: null,
  models: [
    { id: "sonnet-5", label: "Sonnet 5", family: "sonnet", isDefault: true, isUserDefault: false },
    { id: "haiku-4", label: "Haiku 4", family: "haiku", isDefault: false, isUserDefault: false },
  ],
};

async function mount() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<ConversationModelPicker botId="bot-1" />));
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("is absent without the engine", async () => {
  state.status = { enabled: false };
  const view = await mount();
  try {
    expect(view.container.querySelector('[data-testid="conversation-model-trigger"]')).toBeNull();
  } finally {
    state.status = { enabled: true };
    await view.cleanup();
  }
});

it("lists the models for the Conversation's harness and pins the one chosen", async () => {
  state.sessionModel.mockResolvedValue({ harness: "pi", model: null, catalog });
  state.setSessionModel.mockResolvedValue({ ok: true });
  const view = await mount();
  try {
    const trigger = view.container.querySelector(
      '[data-testid="conversation-model-trigger"]',
    ) as HTMLElement;
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger.click();
    });
    await act(async () => {});
    expect(state.sessionModel).toHaveBeenCalledWith({ botId: "bot-1" });
    const menu = document.querySelector('[data-testid="conversation-model-menu"]') as HTMLElement;
    expect(menu.textContent).toContain("Default · Sonnet 5");
    const haiku = [...menu.querySelectorAll('[role="menuitemradio"]')].find((el) =>
      el.textContent?.includes("Haiku 4"),
    ) as HTMLElement;
    await act(async () => haiku.click());
    expect(state.setSessionModel).toHaveBeenCalledWith({ botId: "bot-1", model: "haiku-4" });
  } finally {
    await view.cleanup();
  }
});
