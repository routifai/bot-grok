// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act, createContext, useContext } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ settings: vi.fn(), updateSettings: vi.fn() }));
vi.mock("../../lib/rpc", () => ({ rpc: { muse: api } }));
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
    const times = [...container.querySelectorAll("input[type=time]")] as HTMLInputElement[];
    expect(times.map((input) => input.value)).toEqual(["22:00", "08:00"]);
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
    expect(container.querySelectorAll("input[type=time]").length).toBe(0);
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
