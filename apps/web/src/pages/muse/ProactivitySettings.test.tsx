// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act, createContext, useContext } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../test/i18n")).withI18nRoot(await orig<typeof import("react-dom/client")>()),
);

const api = vi.hoisted(() => ({ settings: vi.fn(), updateSettings: vi.fn() }));
const preferences = vi.hoisted(() => ({ update: vi.fn().mockResolvedValue({}) }));
vi.mock("../../lib/rpc", () => ({ rpc: { muse: api, preferences } }));
vi.mock("../../lib/local-timezone", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/local-timezone")>()),
  localTimezone: () => "America/Toronto",
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

const TabsContext = createContext<{ value: string; onValueChange: (value: string) => void } | null>(
  null,
);

vi.mock("@aiden/ui-web", () => {
  const Container = ({ children, ...props }: ComponentProps<"div">) => (
    <div {...props}>{children}</div>
  );
  return {
    cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Switch: ({
      checked,
      onCheckedChange,
      ...props
    }: {
      checked: boolean;
      onCheckedChange: (checked: boolean) => void;
    } & Omit<ComponentProps<"button">, "onChange">) => (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onCheckedChange(!checked)}
        {...props}
      />
    ),
    Tabs: ({
      value,
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: (value: string) => void;
      children: ReactNode;
    }) => <TabsContext.Provider value={{ value, onValueChange }}>{children}</TabsContext.Provider>,
    TabsList: Container,
    TabsTrigger: ({ value, children }: { value: string; children: ReactNode }) => {
      const ctx = useContext(TabsContext);
      return (
        <button
          type="button"
          data-testid={`level-${value}`}
          aria-pressed={ctx?.value === value}
          onClick={() => ctx?.onValueChange(value)}
        >
          {children}
        </button>
      );
    },
  };
});

import { ProactivitySettings } from "./ProactivitySettings";

function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  return { container, root };
}

it("renders the default proactivity level and quiet hours", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.settings.mockResolvedValue({ proactivity: "normal", quietHours: "22:00-08:00" });
  const { container, root } = render();
  try {
    await act(async () => root.render(<ProactivitySettings botId="bot-1" />));
    expect(api.settings).toHaveBeenCalledWith({ botId: "bot-1" });
    expect(
      container.querySelector('[data-testid="level-normal"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    const times = [...container.querySelectorAll("select")] as HTMLSelectElement[];
    expect(times.map((select) => select.value)).toEqual(["22:00", "08:00"]);
    // 12-hour clock, no leading zero.
    expect(times.map((select) => select.selectedOptions[0]?.textContent)).toEqual([
      "10:00 PM",
      "8:00 AM",
    ]);
    expect(container.textContent).toContain("Toronto (Eastern Time)");
    expect(container.textContent).not.toContain("America/Toronto");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("sends the right payload when the level changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.settings.mockResolvedValue({ proactivity: "normal", quietHours: "22:00-08:00" });
  api.updateSettings.mockResolvedValue({ proactivity: "high", quietHours: "22:00-08:00" });
  const { container, root } = render();
  try {
    await act(async () => root.render(<ProactivitySettings botId="bot-1" />));
    const highButton = container.querySelector<HTMLButtonElement>('[data-testid="level-high"]');
    expect(highButton).not.toBeNull();
    await act(async () => highButton?.click());
    expect(api.updateSettings).toHaveBeenCalledWith({
      botId: "bot-1",
      proactivity: "high",
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("turns quiet hours off by sending quietHours: null", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.settings.mockResolvedValue({ proactivity: "normal", quietHours: "22:00-08:00" });
  api.updateSettings.mockResolvedValue({ proactivity: "normal", quietHours: null });
  const { container, root } = render();
  try {
    await act(async () => root.render(<ProactivitySettings botId="bot-1" />));
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(toggle).not.toBeNull();
    await act(async () => toggle?.click());
    expect(api.updateSettings).toHaveBeenCalledWith({
      botId: "bot-1",
      quietHours: null,
    });
    expect(container.querySelectorAll("select").length).toBe(0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("shows the error inline and reverts when saving fails", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.settings.mockResolvedValue({ proactivity: "normal", quietHours: "22:00-08:00" });
  api.updateSettings.mockRejectedValue(new Error("network down"));
  const { container, root } = render();
  try {
    await act(async () => root.render(<ProactivitySettings botId="bot-1" />));
    const highButton = container.querySelector<HTMLButtonElement>('[data-testid="level-high"]');
    await act(async () => highButton?.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("network down");
    expect(
      container.querySelector('[data-testid="level-normal"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
