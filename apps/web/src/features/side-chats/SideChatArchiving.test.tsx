// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../test/i18n")).withI18nRoot(await orig<typeof import("react-dom/client")>()),
);

const api = vi.hoisted(() => ({ archiving: vi.fn(), updateArchiving: vi.fn() }));
vi.mock("../../lib/rpc", () => ({ rpc: { muse: api } }));

import { SideChatArchiving } from "./SideChatArchiving";

async function mount(days: number | null, defaultDays = 30) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.archiving.mockResolvedValue({ sideChatAutoArchiveDays: days, defaultDays });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<SideChatArchiving botId="bot-1" />));
  return {
    container,
    select: () => container.querySelector("select") as HTMLSelectElement,
    done: async () => {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

it("shows the effective value with the four choices", async () => {
  const view = await mount(30);
  try {
    expect(api.archiving).toHaveBeenCalledWith({ botId: "bot-1" });
    expect(view.container.querySelector("label")?.textContent).toBe("Archive side chats");
    expect(view.select().value).toBe("30");
    expect([...view.select().options].map((option) => option.textContent)).toEqual([
      "Never",
      "After a day",
      "After a week",
      "After a month",
    ]);
  } finally {
    await view.done();
  }
});

it("saves the chosen days, and Never as null", async () => {
  const view = await mount(7);
  try {
    expect(view.select().value).toBe("7");
    api.updateArchiving.mockResolvedValue({ sideChatAutoArchiveDays: 30, defaultDays: 30 });
    await act(async () => {
      view.select().value = "30";
      view.select().dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(api.updateArchiving).toHaveBeenLastCalledWith({
      botId: "bot-1",
      sideChatAutoArchiveDays: 30,
    });
    api.updateArchiving.mockResolvedValue({ sideChatAutoArchiveDays: null, defaultDays: 30 });
    await act(async () => {
      view.select().value = "never";
      view.select().dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(api.updateArchiving).toHaveBeenLastCalledWith({
      botId: "bot-1",
      sideChatAutoArchiveDays: null,
    });
  } finally {
    await view.done();
  }
});

it("reverts and shows the error when saving fails", async () => {
  const view = await mount(null);
  try {
    api.updateArchiving.mockRejectedValue(new Error("nope"));
    await act(async () => {
      view.select().value = "1";
      view.select().dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(view.select().value).toBe("never");
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe("nope");
  } finally {
    await view.done();
  }
});

it("shows an explicit Never, and a non-standard default as the closest choice", async () => {
  const never = await mount(null);
  try {
    expect(never.select().value).toBe("never");
  } finally {
    await never.done();
  }
  const odd = await mount(1, 1);
  try {
    expect(odd.select().value).toBe("1");
  } finally {
    await odd.done();
  }
});
