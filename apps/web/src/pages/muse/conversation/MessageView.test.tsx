// @vitest-environment jsdom

import type { ThreadMessage } from "@aiden/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((acc, part, i) => `${acc}${part}${values[i] ?? ""}`, "");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@lingui/core/macro", () => ({ t: () => "" }));
vi.mock("@aiden/chat-ui/web", () => ({ ChatMarkdown: () => null }));
vi.mock("../../../components/ArtifactFileCard", () => ({ ArtifactFileCard: () => null }));
vi.mock("../../../components/AskCard", () => ({ AskCard: () => null }));
vi.mock("../../../components/ai/CollaborationMarker", () => ({ CollaborationMarker: () => null }));
vi.mock("../../../components/CloudAgentCard", () => ({ CloudAgentCard: () => null }));
vi.mock("../../../components/cards/ReplyCard", () => ({ ReplyCardBlockView: () => null }));
vi.mock("../../../components/teach/SkillDraftCard", () => ({ SkillDraftCard: () => null }));
vi.mock("../../shell/message-cards", () => ({
  AppConnectCard: () => null,
  ArtifactImage: () => null,
  CanvasBlockView: () => null,
  ChartBlockView: () => null,
  ChoiceCard: () => null,
  McpApprovalCard: () => null,
}));
vi.mock("../intro", () => ({ FirstRunHint: () => null }));
vi.mock("./HelperTracker", () => ({ HelperTracker: () => null }));
vi.mock("@aiden/ui-web", () => ({
  BotAvatar: () => null,
  Button: () => null,
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
  resolvePersonaColorDef: () => ({}),
}));

import { MessageView } from "./MessageView";

async function render(code: string) {
  const message: ThreadMessage = {
    id: "i1",
    threadId: "s1",
    seq: 0,
    role: "bot",
    blocks: [{ kind: "error", code }],
    createdAt: "2026-10-01T10:00:00.000Z",
  };
  const host = document.createElement("div");
  document.body.append(host);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    createRoot(host).render(
      <MessageView
        museMode
        artifactTarget={{ botId: "bot-1" }}
        canAnswer={false}
        message={message}
        onAnswer={async () => undefined}
        onOpenBot={() => undefined}
        onOpenPeerMessages={() => undefined}
        peerBot={() => undefined}
        onJumpToMessage={() => undefined}
        onRefresh={async () => undefined}
        onBotChanged={async () => undefined}
        onAddRoutine={() => undefined}
        voiceReady={false}
        speaking={false}
        onSpeak={() => undefined}
        onOpenComputer={() => undefined}
      />,
    );
  });
  return host.querySelector('[data-testid="message-error-note"]')?.textContent;
}

it("shows a known error code as its own short copy", async () => {
  expect(await render("provider_unavailable")).toBe("I lost the connection. Try again.");
  expect(await render("timeout")).toBe("That took too long. Try again.");
});

it("falls back to a generic line for a code it has no copy for, never the code itself", async () => {
  expect(await render("some_new_provider_code")).toBe(
    "Something went wrong on my side. Try again.",
  );
});
