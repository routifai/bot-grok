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

const runtime = {
  busy: false,
  agent: "superchat-claude",
  agents: [
    { name: "superchat-claude", harness: "claude-sdk" },
    { name: "superchat-pi", harness: "pi" },
  ],
  runners: [
    {
      hostId: "host-desk",
      name: "desk",
      kind: "host",
      provider: null,
      online: true,
      current: true,
      movable: false,
    },
    {
      hostId: "host-laptop",
      name: "laptop",
      kind: "host",
      provider: null,
      online: true,
      current: false,
      movable: true,
    },
  ],
  managed: false,
  connectCommand: null,
};

function makeWire(overrides: Partial<ComputerStatusWire> = {}) {
  return {
    status: async () => ({ state: "running", kind: "docker", runnerReady: true }),
    host: async () => ({
      hostId: "host-desk",
      agentName: "superchat-claude",
      harness: "claude-sdk",
    }),
    sessionModel: async () => ({
      harness: "claude-sdk",
      model: null,
      catalog: { defaultModel: "sonnet-5", models: [{ id: "sonnet-5", label: "Sonnet 5" }] },
    }),
    runtime: vi.fn(async () => runtime),
    setAgent: vi.fn(async ({ agent }: { agent: string }) => ({ agent })),
    moveRunner: vi.fn(async ({ hostId }: { hostId: string }) => ({ hostId })),
    ...overrides,
  } as unknown as ComputerStatusWire;
}

async function render(wire: ComputerStatusWire) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<ComputerStatusPanel botId="bot-1" wire={wire} />));
  await act(async () => {});
  return {
    container,
    click: async (selector: string) => {
      const el = container.querySelector<HTMLElement>(selector);
      if (!el) throw new Error(`missing ${selector}`);
      await act(async () => el.click());
      await act(async () => {});
    },
    done: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("shows where it runs, the harness picker and the model", async () => {
  const view = await render(makeWire());
  try {
    const text = view.container.textContent ?? "";
    for (const expected of [
      "Running",
      "desk",
      "laptop",
      "Claude Agent SDK",
      "Pi",
      "Default · Sonnet 5",
    ]) {
      expect(text).toContain(expected);
    }
    expect(
      view.container
        .querySelector('[data-testid="harness-picker-superchat-claude"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      view.container.querySelector<HTMLButtonElement>('[data-testid="runner-host-desk"]')?.disabled,
    ).toBe(true);
  } finally {
    await view.done();
  }
});

it("switches the harness through the engine", async () => {
  const wire = makeWire();
  const view = await render(wire);
  try {
    await view.click('[data-testid="harness-picker-superchat-pi"]');
    expect(wire.setAgent).toHaveBeenCalledWith({ botId: "bot-1", agent: "superchat-pi" });
  } finally {
    await view.done();
  }
});

it("holds the harness while a reply runs", async () => {
  const wire = makeWire({ runtime: vi.fn(async () => ({ ...runtime, busy: true })) as never });
  const view = await render(wire);
  try {
    const pi = view.container.querySelector<HTMLButtonElement>(
      '[data-testid="harness-picker-superchat-pi"]',
    );
    expect(pi?.disabled).toBe(true);
    expect(view.container.textContent).toContain("Switch after the current reply.");
  } finally {
    await view.done();
  }
});

it("moves the Conversation to another host, in its home folder by default", async () => {
  const wire = makeWire();
  const view = await render(wire);
  try {
    await view.click('[data-testid="runner-host-laptop"]');
    const form = view.container.querySelector("form");
    expect(form).not.toBeNull();
    await act(async () => form?.requestSubmit());
    await act(async () => {});
    expect(wire.moveRunner).toHaveBeenCalledWith({
      botId: "bot-1",
      hostId: "host-laptop",
      workspace: undefined,
    });
  } finally {
    await view.done();
  }
});

it("keeps a managed Computer's Conversation in place and shows how to add a host", async () => {
  const wire = makeWire({
    runtime: vi.fn(async () => ({
      ...runtime,
      managed: true,
      runners: [
        {
          hostId: "host-box",
          name: "box",
          kind: "computer",
          provider: "docker",
          online: true,
          current: true,
          movable: false,
        },
      ],
      connectCommand: "omni host --server http://engine.test",
    })) as never,
  });
  const view = await render(wire);
  try {
    expect(view.container.textContent).toContain("Superchat Computer");
    expect(view.container.textContent).toContain("docker · Online");
    expect(view.container.querySelector('[data-testid="connect-host-command"]')?.textContent).toBe(
      "omni host --server http://engine.test",
    );
  } finally {
    await view.done();
  }
});
