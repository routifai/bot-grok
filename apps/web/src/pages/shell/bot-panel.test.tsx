// @vitest-environment jsdom

import type { Bot, Me } from "@aiden/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../test/i18n")).withI18nRoot(await orig<typeof import("react-dom/client")>()),
);

const api = vi.hoisted(() => ({
  voice: { voices: vi.fn().mockResolvedValue([]) },
  models: { credentials: vi.fn().mockResolvedValue([]), list: vi.fn().mockResolvedValue([]) },
  me: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({ rpc: api }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
vi.mock("./avatar-studio-popover", () => ({ AvatarStudioPopover: () => <div /> }));
vi.mock("../ScratchpadSection", () => ({ ScratchpadSection: () => <div /> }));
vi.mock("../SkillsSection", () => ({ SkillsSection: () => <div /> }));
vi.mock("@aiden/ui-web", () => {
  const Container = ({ children, ...props }: ComponentProps<"div">) => (
    <div {...props}>{children}</div>
  );
  return {
    Button: (props: ComponentProps<"button">) => <button {...props} />,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
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
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
    Toggle: Container,
  };
});

import { BotSettings } from "./bot-panel";

function bot(): Bot {
  return {
    id: "bot-1",
    spaceId: "space-1",
    name: "My Muse",
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
  };
}

function me(): Me {
  return {} as Me;
}

function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  return { container, root };
}

it("never renders a proactivity control (it now lives in Settings > Aiden)", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.me.mockResolvedValue(me());
  const { container, root } = render();
  try {
    await act(async () =>
      root.render(
        <BotSettings
          bot={bot()}
          onSkillsChange={() => undefined}
          onSave={async () => undefined}
          onExport={async () => undefined}
          onClear={() => undefined}
        />,
      ),
    );
    await act(async () => undefined);
    expect(container.querySelector('[data-testid="proactivity-settings"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
