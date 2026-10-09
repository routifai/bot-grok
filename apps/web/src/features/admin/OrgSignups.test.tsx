// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../test/i18n")).withI18nRoot(await orig<typeof import("react-dom/client")>()),
);

const api = vi.hoisted(() => ({
  settings: vi.fn(),
  update: vi.fn(),
  pending: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  restore: vi.fn(),
  discard: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({ rpc: { signups: api } }));

import { OrgSignups } from "./OrgSignups";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const waiting = [
  {
    userId: "u1",
    email: "ada@corp.test",
    name: "Ada",
    emailVerified: true,
    previousSpace: null,
    createdAt: "2026-10-01T09:30:00Z",
  },
];
const kept = { createdAt: "2026-09-01T10:00:00Z", lastActive: "2026-09-20T10:00:00Z", muses: 2 };
const squatted = {
  userId: "u2",
  email: "dave@corp.test",
  name: "Dave",
  emailVerified: false,
  previousSpace: null,
  createdAt: "2026-10-02T09:30:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  api.settings.mockResolvedValue({ mode: "approval", invites: [], domains: ["corp.test"] });
  api.pending.mockResolvedValue(waiting);
  api.update.mockResolvedValue({ mode: "open", invites: [], domains: ["corp.test"] });
  api.approve.mockResolvedValue({ ok: true });
  api.reject.mockResolvedValue({ ok: true });
  api.restore.mockResolvedValue({ ok: true });
  api.discard.mockResolvedValue({ ok: true });
});

async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<OrgSignups />));
  await act(async () => {});
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const named = (el: ParentNode, label: string) =>
  [...el.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;

it("lists who is waiting and approves or rejects them", async () => {
  const view = await mount();
  try {
    const row = view.container.querySelector('[data-testid="signup-u1"]')!;
    expect(row.textContent).toContain("ada@corp.test");
    await act(async () => named(row, "Approve").click());
    expect(api.approve).toHaveBeenCalledWith({ userId: "u1" });
    await act(async () => named(row, "Reject").click());
    expect(api.reject).toHaveBeenCalledWith({ userId: "u1" });
    expect(api.pending).toHaveBeenCalledTimes(3);
  } finally {
    await view.cleanup();
  }
});

it("shows unverified rows with a badge, the signup time and a warning to confirm another way", async () => {
  api.pending.mockResolvedValue([...waiting, squatted]);
  const view = await mount();
  try {
    const verified = view.container.querySelector('[data-testid="signup-u1"]')!;
    const unverified = view.container.querySelector('[data-testid="signup-u2"]')!;
    expect(verified.querySelector('[data-testid="signup-unverified"]')).toBeNull();
    expect(unverified.querySelector('[data-testid="signup-unverified"]')?.textContent).toBe(
      "Email not verified",
    );
    expect(unverified.querySelector("time")?.getAttribute("datetime")).toBe(squatted.createdAt);
    expect(unverified.querySelector("time")?.textContent).toMatch(/2026/);
    expect(view.container.textContent).toContain("only after confirming the person another way");
    await act(async () => named(unverified, "Reject").click());
    expect(api.reject).toHaveBeenCalledWith({ userId: "u2" });
  } finally {
    await view.cleanup();
  }
});

it("does not warn when everyone waiting has verified their email", async () => {
  const view = await mount();
  try {
    expect(view.container.textContent).not.toContain("confirming the person another way");
  } finally {
    await view.cleanup();
  }
});

it("offers to restore or discard a kept previous space, with the note to confirm the person", async () => {
  api.pending.mockResolvedValue([{ ...waiting[0], previousSpace: kept }]);
  const view = await mount();
  try {
    const row = view.container.querySelector('[data-testid="signup-u1"]')!;
    expect(row.querySelector('[data-testid="signup-quarantined"]')?.textContent).toBe(
      "Previous space kept: confirm it's the same person",
    );
    await act(async () => named(row, "Restore previous space").click());
    expect(api.restore).toHaveBeenCalledWith({ userId: "u1" });
    expect(row.querySelector('[data-testid="signup-evidence"]')?.textContent).toMatch(
      /Created .*2026 · Last active .*2026 · 2 Muses/,
    );
    // Discarding is destructive: it asks first, and nothing is sent until confirmed.
    await act(async () => named(row, "Discard").click());
    expect(api.discard).not.toHaveBeenCalled();
    const dialog = document.querySelector('[data-testid="discard-space-dialog"]')!;
    expect(dialog.textContent).toContain("removed for good");
    await act(async () => named(dialog, "Cancel").click());
    expect(api.discard).not.toHaveBeenCalled();
    await act(async () => named(row, "Discard").click());
    await act(async () =>
      named(document.querySelector('[data-testid="discard-space-dialog"]')!, "Discard").click(),
    );
    expect(api.discard).toHaveBeenCalledWith({ userId: "u1" });
    // Approving instead gives a clean space; it stays available.
    expect(named(row, "Approve")).toBeTruthy();
  } finally {
    await view.cleanup();
  }
});

it("shows no restore or discard when nothing is kept", async () => {
  const view = await mount();
  try {
    const row = view.container.querySelector('[data-testid="signup-u1"]')!;
    expect(row.querySelector('[data-testid="signup-quarantined"]')).toBeNull();
    expect(named(row, "Restore previous space")).toBeUndefined();
  } finally {
    await view.cleanup();
  }
});

it("says when no one is waiting", async () => {
  api.pending.mockResolvedValue([]);
  const view = await mount();
  try {
    expect(view.container.textContent).toContain("No one is waiting.");
  } finally {
    await view.cleanup();
  }
});

it("changes the signup mode", async () => {
  const view = await mount();
  try {
    await act(async () =>
      (
        view.container.querySelector('[data-testid="signup-mode-open"]') as HTMLButtonElement
      ).click(),
    );
    expect(api.update).toHaveBeenCalledWith({ mode: "open" });
  } finally {
    await view.cleanup();
  }
});

it("edits the domain list only in domain mode and saves it as a list", async () => {
  api.settings.mockResolvedValue({ mode: "domain", invites: [], domains: ["corp.test"] });
  const view = await mount();
  try {
    const field = view.container.querySelector<HTMLTextAreaElement>('[data-testid="signup-list"]')!;
    expect(field.value).toBe("corp.test");
    expect(named(view.container, "Save").disabled).toBe(true);
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    act(() => {
      set?.call(field, "corp.test\nother.test");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => named(view.container, "Save").click());
    expect(api.update).toHaveBeenCalledWith({ domains: ["corp.test", "other.test"] });
  } finally {
    await view.cleanup();
  }
});

it("hides the list outside invite and domain modes", async () => {
  const view = await mount();
  try {
    expect(view.container.querySelector('[data-testid="signup-list"]')).toBeNull();
  } finally {
    await view.cleanup();
  }
});
