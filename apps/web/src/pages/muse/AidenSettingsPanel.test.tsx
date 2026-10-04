// @vitest-environment jsdom

import type { Bot } from "@aiden/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const museApi = vi.hoisted(() => ({ settings: vi.fn(), updateSettings: vi.fn() }));
const preferencesApi = vi.hoisted(() => ({ update: vi.fn().mockResolvedValue({}) }));
vi.mock("../../lib/rpc", () => ({ rpc: { muse: museApi, preferences: preferencesApi } }));
vi.mock("./ApprovalsSettings", () => ({ ApprovalsSettings: () => null }));
vi.mock("./VaultSettings", () => ({ VaultSettings: () => null }));
vi.mock("../../lib/auth", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "user-1" } }, isPending: false }) },
}));

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

vi.mock("@aiden/ui-web", () => ({
  cn: (...parts: unknown[]) => parts.filter(Boolean).join(" "),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
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
  }) => {
    (window as unknown as { __tabsOnChange?: (v: string) => void }).__tabsOnChange = onValueChange;
    return (
      <div data-testid="tabs" data-value={value}>
        {children}
      </div>
    );
  },
  TabsList: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ value, children }: { value: string; children: ReactNode }) => (
    <button
      type="button"
      data-testid={`level-${value}`}
      onClick={() =>
        (window as unknown as { __tabsOnChange?: (v: string) => void }).__tabsOnChange?.(value)
      }
    >
      {children}
    </button>
  ),
}));

vi.mock("../shell/avatar-studio-popover", () => ({
  AvatarStudioPopover: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <button
      type="button"
      data-testid="avatar-studio-stub"
      data-color={value}
      onClick={() => onChange("#FF0000")}
    >
      avatar
    </button>
  ),
}));

import { AidenSettingsPanel } from "./AidenSettingsPanel";

function bot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    spaceId: "space-1",
    name: "Aiden",
    title: "",
    description: "",
    instructions: "",
    color: "#0090FF",
    notifyOnFinish: true,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    unread: false,
    parentBotId: null,
    threadId: "thread-1",
    preview: "",
    status: "idle",
    computerMode: "team",
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    voiceId: null,
    autoSpeak: false,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    teamChatAmbientEnabled: false,
    teamChatRules: "",
    webhookConfigured: false,
    spawnKey: null,
    ...overrides,
  };
}

function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  return { container, root };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("saves the name on blur when it changed", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  museApi.settings.mockResolvedValue({ proactivity: "normal", quietHours: "22:00-08:00" });
  const onSave = vi.fn().mockResolvedValue(undefined);
  const { container, root } = render();
  try {
    await act(async () => root.render(<AidenSettingsPanel bot={bot()} onSave={onSave} />));
    const input = container.querySelector<HTMLInputElement>("input");
    expect(input?.value).toBe("Aiden");
    await act(async () => setInputValue(input!, "Nova"));
    await act(async () => {
      input!.dispatchEvent(new Event("focusout", { bubbles: true }));
    });
    expect(onSave).toHaveBeenCalledWith({ name: "Nova" });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("saves the color chosen from the reused avatar studio", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  museApi.settings.mockResolvedValue({ proactivity: "normal", quietHours: "22:00-08:00" });
  const onSave = vi.fn().mockResolvedValue(undefined);
  const { container, root } = render();
  try {
    await act(async () => root.render(<AidenSettingsPanel bot={bot()} onSave={onSave} />));
    const avatarButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="avatar-studio-stub"]',
    );
    await act(async () => avatarButton?.click());
    expect(onSave).toHaveBeenCalledWith({ color: "#FF0000" });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("wires the reused ProactivitySettings to the bot's id", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  museApi.settings.mockResolvedValue({ proactivity: "high", quietHours: "22:00-08:00" });
  const { container, root } = render();
  try {
    await act(async () => root.render(<AidenSettingsPanel bot={bot()} onSave={vi.fn()} />));
    await act(async () => undefined);
    expect(museApi.settings).toHaveBeenCalledWith({ botId: "bot-1" });
    expect(container.querySelector('[data-testid="proactivity-settings"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
