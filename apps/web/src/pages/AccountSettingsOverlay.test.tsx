// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));

vi.mock("react-router-dom", () => ({
  Link: ({ children, ...props }: ComponentProps<"a">) => <a {...props}>{children}</a>,
}));

vi.mock("../components/ApprovalRulesSettings", () => ({
  ApprovalRulesSettings: () => <div data-testid="approval-rules-stub" />,
}));

vi.mock("@aiden/ui-web", () => {
  const Container = ({ children, ...props }: ComponentProps<"div">) => (
    <div {...props}>{children}</div>
  );
  return {
    BotAvatar: () => <div data-testid="bot-avatar" />,
    Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
    Field: Container,
    // Rendered as <span>, not <label>: this is a presentational stub, not the real
    // form control, so it doesn't need a label/control association.
    FieldLabel: ({ children, ...props }: ComponentProps<"span">) => (
      <span {...props}>{children}</span>
    ),
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Label: ({ children, ...props }: ComponentProps<"span">) => <span {...props}>{children}</span>,
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
    Toggle: ({
      pressed,
      onPressedChange,
      children,
      ...props
    }: {
      pressed?: boolean;
      onPressedChange?: (pressed: boolean) => void;
      children?: ReactNode;
    } & Omit<ComponentProps<"button">, "onChange">) => (
      <button
        type="button"
        aria-pressed={pressed}
        onClick={() => onPressedChange?.(!pressed)}
        {...props}
      >
        {children}
      </button>
    ),
  };
});

import { GeneralSettingsPanels } from "./AccountSettingsOverlay";

function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  return { container, root };
}

const baseProps = {
  name: "Person",
  avatarStyle: "robot" as const,
  onAvatarStyleChange: async () => undefined,
  messagingEnabled: true,
  onOpenMessaging: () => undefined,
};

it("upstream mode: shows Avatars and Messaging", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { container, root } = render();
  try {
    await act(async () => root.render(<GeneralSettingsPanels {...baseProps} />));
    expect(container.querySelector('[data-testid="avatar-style-select"]')).not.toBeNull();
    expect(container.textContent).toContain("Messaging");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("muse mode: hides Avatars and Messaging", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { container, root } = render();
  try {
    await act(async () => root.render(<GeneralSettingsPanels {...baseProps} museMode />));
    expect(container.querySelector('[data-testid="avatar-style-select"]')).toBeNull();
    expect(container.textContent).not.toContain("Messaging");
    // Everything else stays: Account, Password, Appearance, Advanced. English only: no Language.
    expect(container.textContent).toContain("Account");
    expect(container.textContent).toContain("Appearance");
    expect(container.textContent).not.toContain("Language");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
