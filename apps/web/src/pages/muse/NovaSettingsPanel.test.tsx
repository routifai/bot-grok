// @vitest-environment jsdom

import type { Bot } from "@nova/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../test/i18n")).withI18nRoot(await orig<typeof import("react-dom/client")>()),
);

const museApi = vi.hoisted(() => ({ settings: vi.fn(), updateSettings: vi.fn() }));
const preferencesApi = vi.hoisted(() => ({ update: vi.fn().mockResolvedValue({}) }));
vi.mock("../../lib/rpc", () => ({ rpc: { muse: museApi, preferences: preferencesApi } }));
vi.mock("./ApprovalsSettings", () => ({ ApprovalsSettings: () => null }));
vi.mock("./VaultSettings", () => ({ VaultSettings: () => null }));
vi.mock("./SideChatArchiving", () => ({ SideChatArchiving: () => null }));
vi.mock("../../lib/auth", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "user-1" } }, isPending: false }) },
}));

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

vi.mock("@nova/ui-web", () => ({
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

vi.mock("../../components/ai/orb", () => ({
  NovaOrb: () => <span data-testid="nova-orb" />,
}));

import { NovaSettingsPanel } from "./NovaSettingsPanel";

function bot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    spaceId: "space-1",
    name: "Nova",
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
    await act(async () => root.render(<NovaSettingsPanel bot={bot()} onSave={onSave} />));
    const input = container.querySelector<HTMLInputElement>("input");
    expect(input?.value).toBe("Nova");
    await act(async () => setInputValue(input!, "Atlas"));
    await act(async () => {
      input!.dispatchEvent(new Event("focusout", { bubbles: true }));
    });
    expect(onSave).toHaveBeenCalledWith({ name: "Atlas" });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("shows the orb, not the old mascot or a color picker", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  museApi.settings.mockResolvedValue({ proactivity: "normal", quietHours: "22:00-08:00" });
  const { container, root } = render();
  try {
    await act(async () =>
      root.render(<NovaSettingsPanel bot={bot()} onSave={vi.fn().mockResolvedValue(undefined)} />),
    );
    expect(container.querySelector('[data-testid="nova-orb"]')).not.toBeNull();
    expect(container.textContent).not.toContain("change the color");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
