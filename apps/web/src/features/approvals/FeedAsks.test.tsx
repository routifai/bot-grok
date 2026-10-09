// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../test/i18n")).withI18nRoot(await orig<typeof import("react-dom/client")>()),
);
vi.mock("../../lib/relative-time", () => ({ formatRelativeTime: () => "2h ago" }));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((acc, part, i) => `${acc}${part}${values[i] ?? ""}`, ""),
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((acc, part, i) => `${acc}${part}${values[i] ?? ""}`, "");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});

import type { Ask } from "@nova/contracts";
import { FeedAsks } from "./FeedAsks";

const ask: Ask = {
  id: "ask-9",
  runId: "run-9",
  kind: "question",
  goalId: null,
  goalTitle: null,
  text: "Which evenings work?",
  choices: [{ id: "mon", label: "Monday" }],
  input: null,
  createdAt: new Date().toISOString(),
};

it("lists open Asks and answers one with its choice id", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onAnswer = vi.fn().mockResolvedValue(undefined);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<FeedAsks asks={[ask]} onAnswer={onAnswer} />));
  try {
    expect(container.textContent).toContain("Which evenings work?");
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Monday",
    );
    await act(async () => button?.click());
    expect(onAnswer).toHaveBeenCalledWith(ask, "mon");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("renders nothing without Asks", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<FeedAsks asks={[]} onAnswer={vi.fn()} />));
  expect(container.textContent).toBe("");
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
