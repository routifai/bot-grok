// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { type ClaimsWire, groupClaims, type MemoryClaim } from "./MemorySections";
import { MemoryTab } from "./MemoryTab";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((acc, part, i) => `${acc}${part}${values[i] ?? ""}`, "");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});

vi.mock("./PanelSkeleton", () => ({ PanelRowSkeletonList: () => null }));

const claim = (over: Partial<MemoryClaim>): MemoryClaim => ({
  id: "c1",
  kind: "fact",
  text: "The user works in finance.",
  origin: "said",
  personAuthored: false,
  date: 1_791_000_000,
  ...over,
});

const mounted: Array<() => void> = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

it("maps claim kinds to sections", () => {
  const groups = groupClaims([
    claim({ id: "a", kind: "preference" }),
    claim({ id: "b", kind: "commitment" }),
    claim({ id: "c", kind: "decision" }),
    claim({ id: "d", kind: "person" }),
    claim({ id: "e", kind: "working_style" }),
  ]);
  expect(groups.map((g) => g.id)).toEqual([
    "about",
    "commitments",
    "projects",
    "people",
    "working",
  ]);
});

it("shows source and date, edits inline and deletes after confirming", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const editClaim = vi.fn(async (input: { text: string }) =>
    claim({ text: input.text, origin: "edited", personAuthored: true }),
  );
  const forgetClaim = vi.fn(async () => ({ ok: true as const }));
  const wire: ClaimsWire & { profile: () => Promise<{ profile: null }> } = {
    profile: async () => ({ profile: null }),
    claims: async () => ({ claims: [claim({}), claim({ id: "p", kind: "person", text: "Maya" })] }),
    editClaim,
    forgetClaim,
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(() => act(() => root.unmount()));
  await act(async () => {
    root.render(<MemoryTab botId="b1" wire={wire} />);
  });
  expect(container.textContent).toContain("About you");
  expect(container.textContent).toContain("People");
  expect(container.textContent).toContain("You said");

  const button = (label: string, index = 0) =>
    [...container.querySelectorAll("button")].filter((b) => b.textContent === label)[
      index
    ] as HTMLElement;
  await act(async () => button("Edit").click());
  const box = container.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(box, "You work in banking.");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Save").click());
  expect(editClaim).toHaveBeenCalledWith({
    botId: "b1",
    claimId: "c1",
    text: "You work in banking.",
  });
  expect(container.textContent).toContain("You edited");

  await act(async () => button("Delete").click());
  expect(forgetClaim).not.toHaveBeenCalled();
  await act(async () => button("Delete").click());
  expect(forgetClaim).toHaveBeenCalledWith({ botId: "b1", claimId: "c1" });
  expect(container.textContent).not.toContain("banking");
});
