// @vitest-environment jsdom

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
vi.mock("../../../lib/rpc", () => ({ rpc: {} }));

import { ComputerStatusPanel, type ComputerStatusWire } from "./ComputerStatusPanel";

const wire = {
  status: async () => ({ state: "running", kind: "docker", runnerReady: true }),
  host: async () => ({ hostId: "host-7", agentName: "superchat-claude", harness: "claude-sdk" }),
  sessionModel: async () => ({
    harness: "claude-sdk",
    model: null,
    catalog: { defaultModel: "sonnet-5", models: [{ id: "sonnet-5", label: "Sonnet 5" }] },
  }),
} as unknown as ComputerStatusWire;

it("shows the host, the harness and the model", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<ComputerStatusPanel botId="bot-1" wire={wire} />));
  await act(async () => {});
  try {
    const text = container.textContent ?? "";
    for (const expected of [
      "Running",
      "host-7",
      "Claude Agent SDK",
      "superchat-claude",
      "Default · Sonnet 5",
    ]) {
      expect(text).toContain(expected);
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
