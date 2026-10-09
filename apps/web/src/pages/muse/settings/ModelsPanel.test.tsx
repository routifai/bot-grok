// @vitest-environment jsdom

import type { EngineModelsStatus } from "@nova/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../../test/i18n")).withI18nRoot(
    await orig<typeof import("react-dom/client")>(),
  ),
);
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((acc, part, i) => `${acc}${part}${values[i] ?? ""}`, "");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});

const api = vi.hoisted(() => ({
  connections: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  catalog: vi.fn(),
  setDefault: vi.fn(),
  budget: vi.fn(),
  setBudget: vi.fn(),
}));
vi.mock("../../../lib/rpc", () => ({ rpc: { engineModels: api } }));

import { ModelsPanel } from "./ModelsPanel";

const status: EngineModelsStatus = {
  enabled: true,
  harnesses: [{ id: "pi", label: "Pi" }],
  isAdmin: false,
  ready: true,
};
const connection = {
  provider: "anthropic",
  hint: "abcd",
  status: "valid",
  validatedAt: 1_792_000_000,
  label: null,
  scope: "user" as const,
};
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

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(el, value);
  el.dispatchEvent(
    new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
  );
}

async function mount(onChanged = vi.fn()) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ModelsPanel status={status} onChanged={onChanged} />);
  });
  await act(async () => {});
  return {
    container,
    onChanged,
    button: (name: string) =>
      [...container.querySelectorAll("button")].find((b) => b.textContent === name),
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function seed(connections = [connection]) {
  api.connections.mockResolvedValue(connections);
  api.catalog.mockResolvedValue(catalog);
  api.budget.mockResolvedValue({
    monthlyLimitUsd: 20,
    atLimit: "ask",
    spentMonthUsd: 5,
    orgLimitUsd: 100,
  });
}

it("lists each provider's key as masked metadata, with Replace and Remove", async () => {
  seed();
  const view = await mount();
  try {
    const anthropic = view.container.querySelector('[data-testid="model-key-anthropic"]');
    expect(anthropic?.textContent).toContain("••••abcd");
    expect(anthropic?.textContent).toContain("Checked");
    expect(anthropic?.textContent).toContain("Replace");
    expect(anthropic?.textContent).toContain("Remove");
    const openrouter = view.container.querySelector('[data-testid="model-key-openrouter"]');
    expect(openrouter?.textContent).toContain("Not connected");
    expect(view.container.textContent).not.toContain("Provided by your organization");
  } finally {
    await view.cleanup();
  }
});

it("adds a key in a password field and shows the engine's rejection inline", async () => {
  seed([]);
  api.connect.mockRejectedValueOnce(new Error("OpenRouter rejected this key"));
  api.connect.mockResolvedValueOnce({ ...connection, provider: "openrouter" });
  const view = await mount();
  try {
    expect(view.container.textContent).toContain("Provided by your organization");
    const row = view.container.querySelector('[data-testid="model-key-openrouter"]');
    await act(async () => {
      [...(row?.querySelectorAll("button") ?? [])]
        .find((b) => b.textContent === "Add key")
        ?.click();
    });
    const input = view.container.querySelector('input[type="password"]') as HTMLInputElement;
    expect(input.autocomplete).toBe("off");
    await act(async () => setValue(input, "sk-or-bad"));
    await act(async () => view.button("Save")?.click());
    expect(api.connect).toHaveBeenCalledWith({ provider: "openrouter", apiKey: "sk-or-bad" });
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
      "OpenRouter rejected this key",
    );
    await act(async () => setValue(input, "sk-or-good"));
    await act(async () => view.button("Save")?.click());
    expect(api.connect).toHaveBeenLastCalledWith({ provider: "openrouter", apiKey: "sk-or-good" });
    expect(view.container.querySelector('input[type="password"]')).toBeNull();
    expect(view.onChanged).toHaveBeenCalled();
  } finally {
    await view.cleanup();
  }
});

it("removes a key", async () => {
  seed();
  api.disconnect.mockResolvedValue({ ok: true });
  const view = await mount();
  try {
    await act(async () => view.button("Remove")?.click());
    expect(api.disconnect).toHaveBeenCalledWith({ provider: "anthropic" });
  } finally {
    await view.cleanup();
  }
});

it("saves the default model chosen for the harness", async () => {
  seed();
  api.setDefault.mockResolvedValue({ pi: "haiku-4" });
  const view = await mount();
  try {
    const select = view.container.querySelector(
      '[data-testid="default-model-pi"] select, select[data-testid="default-model-pi"]',
    ) as HTMLSelectElement;
    expect(select.value).toBe("sonnet-5");
    expect(select.textContent).toContain("Default");
    await act(async () => setValue(select, "haiku-4"));
    expect(api.setDefault).toHaveBeenCalledWith({ harness: "pi", model: "haiku-4" });
  } finally {
    await view.cleanup();
  }
});

it("shows the budget, saves a new limit and the action at the limit, and the organization's cap", async () => {
  seed();
  api.setBudget.mockImplementation(async (input) => ({
    ...input,
    spentMonthUsd: 5,
    orgLimitUsd: 100,
  }));
  const view = await mount();
  try {
    expect(view.container.querySelector('[data-testid="budget-spend"]')?.textContent).toContain(
      "$5 of $20",
    );
    expect(
      view.container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"),
    ).toBe("5");
    expect(view.container.textContent).toContain("Organization limit");
    const limit = view.container.querySelector('input[inputmode="decimal"]') as HTMLInputElement;
    await act(async () => setValue(limit, "50"));
    await act(async () => {
      limit.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(api.setBudget).toHaveBeenCalledWith({ monthlyLimitUsd: 50, atLimit: "ask" });
    await act(async () =>
      (view.container.querySelector('[data-testid="budget-at-limit-stop"]') as HTMLElement).click(),
    );
    expect(api.setBudget).toHaveBeenLastCalledWith({ monthlyLimitUsd: 50, atLimit: "stop" });
    await act(async () => setValue(limit, ""));
    await act(async () => {
      limit.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(api.setBudget).toHaveBeenLastCalledWith({ monthlyLimitUsd: null, atLimit: "stop" });
  } finally {
    await view.cleanup();
  }
});
