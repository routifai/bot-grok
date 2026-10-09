// @vitest-environment jsdom

import type { Bot } from "@nova/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../test/i18n")).withI18nRoot(await orig<typeof import("react-dom/client")>()),
);

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

vi.mock("@nova/ui-web", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
  Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
  Dialog: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DialogContent: ({
    children,
    "data-testid": testId,
    "data-settings-section": section,
  }: {
    children?: ReactNode;
    "data-testid"?: string;
    "data-settings-section"?: string;
  }) => (
    <div data-testid={testId} data-settings-section={section}>
      {children}
    </div>
  ),
  DialogClose: ({
    children,
    "aria-label": ariaLabel,
    disabled,
  }: {
    children?: ReactNode;
    "aria-label"?: string;
    disabled?: boolean;
  }) => (
    <button type="button" aria-label={ariaLabel} disabled={disabled}>
      {children}
    </button>
  ),
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}));

// Every panel below is presentational chrome not under test here: this file only
// exercises the nav (which sections exist, in which order, for which product mode)
// and the wiring into the Nova section. Each stub reports the props it cares about
// via data-testid so assertions can read them back.
vi.mock("./AccountSettingsOverlay", () => ({
  GeneralSettingsPanels: ({ museMode }: { museMode?: boolean }) => (
    <div data-testid="general-panel" data-muse-mode={String(Boolean(museMode))} />
  ),
  UsageSettingsPanel: () => <div data-testid="usage-panel" />,
  ComputerSettingsPanel: () => <div data-testid="computer-panel" />,
  UpdatesSettingsPanel: () => <div data-testid="updates-panel" />,
}));
vi.mock("./ModelSettingsOverlay", () => ({
  ModelSettingsOverlay: () => <div data-testid="models-panel" />,
}));
vi.mock("./VoiceSettingsOverlay", () => ({
  VoiceSettingsOverlay: () => <div data-testid="voice-panel" />,
}));
vi.mock("./muse/settings/GeneralPanel", () => ({
  GeneralPanel: () => <div data-testid="general-panel" data-muse-mode="true" />,
}));
vi.mock("./muse/settings/VoicePanel", () => ({ VoicePanel: () => <div /> }));
vi.mock("./muse/NovaSettingsPanel", () => ({
  NovaSettingsPanel: ({
    bot,
    onSave,
  }: {
    bot: Bot;
    onSave: (patch: { name?: string; color?: string }) => Promise<void>;
  }) => (
    <div data-testid="nova-panel" data-bot-name={bot.name}>
      <button
        type="button"
        data-testid="nova-panel-save"
        onClick={() => void onSave({ name: "New name" })}
      >
        save
      </button>
    </div>
  ),
}));
const engine = vi.hoisted(() => ({ status: null as unknown }));
vi.mock("../lib/engine-models", () => ({
  useEngineModelsStatus: () => [engine.status, () => undefined, true],
}));
vi.mock("./muse/settings/ModelsPanel", () => ({
  ModelsPanel: () => <div data-testid="engine-models-panel" />,
}));
vi.mock("./muse/settings/OrganizationPanel", () => ({
  OrganizationPanel: () => <div data-testid="organization-panel" />,
}));
vi.mock("../components/ComputersUnavailableHint", () => ({
  computersAreUnavailable: () => false,
}));

import { SettingsOverlay } from "./SettingsOverlay";

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

function navIds(container: HTMLElement) {
  return [...container.querySelectorAll("[data-testid^='settings-nav-']")].map((el) =>
    (el.getAttribute("data-testid") ?? "").replace("settings-nav-", ""),
  );
}

const baseProps = {
  name: "Person",
  avatarStyle: "robot" as const,
  onAvatarStyleChange: async () => undefined,
  onClose: () => undefined,
};

it("upstream mode: shows Avatars-capable General and Updates, no Nova section", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { container, root } = render();
  try {
    await act(async () => root.render(<SettingsOverlay {...baseProps} />));
    const ids = navIds(container);
    expect(ids).toEqual(["general", "models", "voice", "usage", "updates"]);
    expect(
      container.querySelector('[data-testid="general-panel"]')?.getAttribute("data-muse-mode"),
    ).toBe("false");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("muse mode: adds Nova first, drops Usage and Updates, and uses the Muse General panel", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { container, root } = render();
  try {
    await act(async () =>
      root.render(
        <SettingsOverlay
          {...baseProps}
          museMode
          museBot={bot({ name: "Nova" })}
          onMuseBotSave={async () => undefined}
        />,
      ),
    );
    const ids = navIds(container);
    expect(ids).toEqual(["nova", "general", "voice"]);
    expect(ids).not.toContain("updates");
    expect(container.querySelector('[data-testid="settings-nav-nova"]')?.textContent).toContain(
      "Nova",
    );
    expect(
      container.querySelector('[data-testid="general-panel"]')?.getAttribute("data-muse-mode"),
    ).toBe("true");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("muse mode: opening Nova renders the panel wired to the Muse bot and its save callback", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onMuseBotSave = vi.fn().mockResolvedValue(undefined);
  const { container, root } = render();
  try {
    await act(async () =>
      root.render(
        <SettingsOverlay
          {...baseProps}
          museMode
          museBot={bot({ name: "Nova" })}
          onMuseBotSave={onMuseBotSave}
        />,
      ),
    );
    const navButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-nav-nova"]',
    );
    await act(async () => navButton?.click());
    const panel = container.querySelector('[data-testid="nova-panel"]');
    expect(panel?.getAttribute("data-bot-name")).toBe("Nova");
    const saveButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="nova-panel-save"]',
    );
    await act(async () => saveButton?.click());
    expect(onMuseBotSave).toHaveBeenCalledWith({ name: "New name" });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

const museProps = {
  ...baseProps,
  museMode: true,
  museBot: null,
  onMuseBotSave: async () => undefined,
};

it("muse mode on the engine: Models for everyone, Organization only for admins", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    for (const [isAdmin, expected] of [
      [false, ["nova", "general", "models", "voice"]],
      [true, ["nova", "general", "models", "voice", "organization"]],
    ] as const) {
      engine.status = { enabled: true, harnesses: [], isAdmin, ready: true };
      const { container, root } = render();
      try {
        await act(async () => root.render(<SettingsOverlay {...museProps} />));
        expect(navIds(container)).toEqual(expected);
        await act(async () =>
          container
            .querySelector<HTMLButtonElement>('[data-testid="settings-nav-models"]')
            ?.click(),
        );
        expect(container.querySelector('[data-testid="engine-models-panel"]')).toBeTruthy();
        expect(container.querySelector('[data-testid="models-panel"]')).toBeNull();
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    }
  } finally {
    engine.status = null;
    vi.unstubAllGlobals();
  }
});

it("opens at Models when asked to, and falls back to General without the engine", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { container, root } = render();
  try {
    engine.status = { enabled: true, harnesses: [], isAdmin: false, ready: false };
    await act(async () => root.render(<SettingsOverlay {...museProps} initialSection="models" />));
    expect(container.querySelector('[data-testid="engine-models-panel"]')).toBeTruthy();
    engine.status = { enabled: false, harnesses: [], isAdmin: false, ready: false };
    await act(async () => root.render(<SettingsOverlay {...museProps} initialSection="models" />));
    expect(container.querySelector('[data-testid="engine-models-panel"]')).toBeNull();
    expect(container.querySelector('[data-settings-section="general"]')).toBeTruthy();
  } finally {
    engine.status = null;
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
