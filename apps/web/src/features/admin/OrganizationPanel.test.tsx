// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../test/i18n")).withI18nRoot(await orig<typeof import("react-dom/client")>()),
);
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((acc, part, i) => `${acc}${part}${values[i] ?? ""}`, "");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});

const api = vi.hoisted(() => ({
  users: vi.fn(),
  setSuspended: vi.fn(),
  deleteUser: vi.fn(),
  usage: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({ rpc: { engineAdmin: api } }));

import { overlayFromDrafts } from "./OrgModels";
import { OrgUsage } from "./OrgUsage";
import { OrgUsers } from "./OrgUsers";

const user = (over: Record<string, unknown>) => ({
  id: "bob@acme.test",
  email: "bob@acme.test",
  isAdmin: false,
  status: "active",
  spendMonthUsd: 12.5,
  spendTodayUsd: 1,
  sessionCount: 7,
  providers: ["anthropic"],
  budget: { monthlyLimitUsd: 50, atLimit: "ask" },
  computer: "online",
  lastActive: 1_792_000_000,
  ...over,
});

async function mount(node: ReactNode) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  await act(async () => {});
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const within = (el: ParentNode, label: string) =>
  [...el.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;

it("lists people with their numbers, status pill and Computer state", async () => {
  api.users.mockResolvedValue([
    user({}),
    user({ id: "eve", email: null, status: "suspended", computer: null, providers: [] }),
  ]);
  const view = await mount(<OrgUsers selfEmail="root@acme.test" />);
  try {
    const bob = view.container.querySelector('[data-testid="org-user-bob@acme.test"]');
    expect(bob?.textContent).toContain("bob@acme.test");
    expect(bob?.textContent).toContain("$12.50");
    expect(bob?.textContent).toContain("Anthropic");
    expect(bob?.textContent).toContain("Online");
    expect(bob?.querySelector('[data-testid="user-status"]')?.textContent).toBe("Active");
    const eve = view.container.querySelector('[data-testid="org-user-eve"]');
    expect(eve?.querySelector('[data-testid="user-status"]')?.textContent).toBe("Paused");
    expect(within(eve as Element, "Resume")).toBeTruthy();
  } finally {
    await view.cleanup();
  }
});

it("suspends, and shows the engine's refusal as is", async () => {
  api.users.mockResolvedValue([user({})]);
  api.setSuspended.mockRejectedValueOnce(new Error("You cannot suspend the last active admin"));
  const view = await mount(<OrgUsers />);
  try {
    await act(async () => within(view.container, "Suspend").click());
    expect(api.setSuspended).toHaveBeenCalledWith({ userId: "bob@acme.test", suspended: true });
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
      "You cannot suspend the last active admin",
    );
  } finally {
    await view.cleanup();
  }
});

it("cannot act on your own row", async () => {
  api.users.mockResolvedValue([user({})]);
  const view = await mount(<OrgUsers selfEmail="Bob@acme.test" />);
  try {
    expect(within(view.container, "Suspend").disabled).toBe(true);
    expect(within(view.container, "Delete").disabled).toBe(true);
  } finally {
    await view.cleanup();
  }
});

it("deletes only after a confirmation that names the person", async () => {
  api.users.mockResolvedValue([user({})]);
  api.deleteUser.mockResolvedValue({ ok: true });
  const view = await mount(<OrgUsers />);
  try {
    await act(async () => within(view.container, "Delete").click());
    const dialog = document.querySelector('[data-testid="delete-user-dialog"]') as HTMLElement;
    expect(dialog.textContent).toContain("Delete bob@acme.test?");
    expect(api.deleteUser).not.toHaveBeenCalled();
    await act(async () => within(dialog, "Cancel").click());
    expect(api.deleteUser).not.toHaveBeenCalled();

    await act(async () => within(view.container, "Delete").click());
    const again = document.querySelector('[data-testid="delete-user-dialog"]') as HTMLElement;
    const confirm = within(again, "Delete");
    expect(confirm.className).toContain("text-destructive");
    await act(async () => confirm.click());
    expect(api.deleteUser).toHaveBeenCalledWith({ userId: "bob@acme.test" });
  } finally {
    await view.cleanup();
  }
});

it("shows usage for the month and switches to today", async () => {
  api.usage.mockImplementation(async ({ window }: { window: string }) => ({
    window,
    totalUsd: window === "month" ? 42 : 3,
    byUser: [{ userId: "bob@acme.test", costUsd: 42 }],
    byDay: [
      { day: "2026-10-01", costUsd: 10 },
      { day: "2026-10-02", costUsd: 32 },
    ],
  }));
  const view = await mount(<OrgUsage />);
  try {
    expect(view.container.querySelector('[data-testid="usage-total"]')?.textContent).toBe("$42");
    expect(view.container.textContent).toContain("bob@acme.test");
    expect(view.container.querySelector('[role="img"]')).toBeTruthy();
    await act(async () =>
      (view.container.querySelector('[data-testid="usage-window-day"]') as HTMLElement).click(),
    );
    expect(api.usage).toHaveBeenLastCalledWith({ window: "day" });
    expect(view.container.querySelector('[data-testid="usage-total"]')?.textContent).toBe("$3");
  } finally {
    await view.cleanup();
  }
});

it("builds the overlay the engine keeps: unrestricted harnesses without a default are absent", () => {
  expect(
    overlayFromDrafts({
      pi: { all: true, allow: ["a"], default: null },
      "claude-sdk": { all: false, allow: ["x", "y"], default: "y" },
      other: { all: true, allow: [], default: "z" },
      stale: { all: false, allow: ["a"], default: "gone" },
    }),
  ).toEqual({
    "claude-sdk": { allow: ["x", "y"], default: "y" },
    other: { allow: null, default: "z" },
    stale: { allow: ["a"], default: null },
  });
});
