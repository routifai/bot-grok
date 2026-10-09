// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../test/i18n")).withI18nRoot(await orig<typeof import("react-dom/client")>()),
);

import { ActivityRunDialog } from "./ActivityRunDialog";
import { activity } from "./activityTestKit";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((acc, part, i) => `${acc}${part}${values[i] ?? ""}`, "");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("../../pages/muse/conversation/MessageRow", () => ({ MessageRow: () => null }));

const mounted: Array<() => void> = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  document.body.innerHTML = "";
});

async function mount(run: ReturnType<typeof activity>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(() => act(() => root.unmount()));
  await act(async () => {
    root.render(
      <ActivityRunDialog
        botId="bot-1"
        wire={{ get: async () => run, helperMessages: async () => ({}) as never }}
        activity={run}
        onOpenChange={() => undefined}
      />,
    );
  });
}

it("shows a scheduled run that never started as 'Couldn't run' with its reason, not Done", async () => {
  await mount(
    activity({
      kind: "sub_agent",
      source: "scheduled",
      title: "8am market and tech report",
      status: "failed",
      outcome: "Your Computer didn't start.",
      summary: "Your Computer didn't start.",
      steps: [],
    }),
  );
  const text = document.body.textContent ?? "";
  expect(text).toContain("Couldn't run");
  expect(text).toContain("Your Computer didn't start.");
  expect(text).not.toContain("Done");
});

it("still says why when the failed run has no outcome text", async () => {
  await mount(activity({ status: "failed", outcome: null, summary: null, steps: [] }));
  const text = document.body.textContent ?? "";
  expect(text).toContain("Couldn't run");
  expect(text).toContain("Something went wrong before it could start.");
});
