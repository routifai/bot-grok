import type * as db from "@aiden/db";
import { describe, expect, it, vi } from "vitest";
import { chooseFocus, markAppConnected, promptFocus } from "./onboarding.js";

const posted = vi.hoisted(() => [] as Array<{ blocks: unknown[] }>);
vi.mock("@aiden/db", async (original) => ({
  ...(await original<typeof db>()),
  createThreadMessageInTransaction: vi.fn(async (_tx, input) => {
    posted.push(input);
    return { id: "posted" };
  }),
  appendEventInTransaction: vi.fn(async () => ({ seq: 1 })),
}));
function fixture(catalog: unknown[]) {
  posted.length = 0;
  const tx = {
    $executeRaw: vi.fn(),
    message: {
      findMany: vi.fn(async () => [{ id: "choice", blocks: [{ kind: "choice", answerId: null }] }]),
      update: vi.fn(),
    },
  };
  const deps = {
    prisma: {
      bot: { findFirst: vi.fn(async () => ({ id: "bot", thread: { id: "thread" } })) },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
    },
    events: { notify: vi.fn() },
    connectors: { managedProviders: () => [{ catalog: async () => catalog }] },
  } as unknown as Parameters<typeof chooseFocus>[0];
  const actor = {
    userId: "user",
    spaceId: "space",
    email: "user@aiden.test",
    isDeploymentOwner: true,
  };
  return { deps, actor, tx };
}

/** Fixture for `promptFocus`: an otherwise-empty thread, optionally in muse mode. */
function promptFixture(productMode?: "aiden" | "muse") {
  posted.length = 0;
  const tx = {
    $executeRaw: vi.fn(),
    message: { findMany: vi.fn(async () => [] as Array<{ role?: string; blocks?: unknown[] }>) },
  };
  const deps = {
    prisma: {
      bot: { findFirst: vi.fn(async () => ({ id: "bot", thread: { id: "thread" } })) },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
    },
    events: { notify: vi.fn() },
    connectors: { managedProviders: () => [] },
    productMode,
  } as unknown as Parameters<typeof promptFocus>[0];
  const actor = {
    userId: "user",
    spaceId: "space",
    email: "user@aiden.test",
    isDeploymentOwner: true,
  };
  return { deps, actor, tx };
}
describe("onboarding connection suggestions", () => {
  it("does not invent authorization cards when no connector has an app catalog", async () => {
    const { deps, actor } = fixture([]);
    await chooseFocus(deps, actor, "bot", "day");
    expect(posted.flatMap((message) => message.blocks)).not.toContainEqual(
      expect.objectContaining({ kind: "app_connect" }),
    );
    expect(posted.length).toBeGreaterThan(0);
  });
  it("uses the available connector and omits unavailable apps", async () => {
    const { deps, actor } = fixture([
      { connectorId: "pipedream", slug: "slack", name: "Slack", connected: false, logo: null },
    ]);
    await chooseFocus(deps, actor, "bot", "day");
    expect(
      posted
        .flatMap((message) => message.blocks)
        .filter((block) => (block as { kind: string }).kind === "app_connect"),
    ).toEqual([
      expect.objectContaining({ connectorId: "pipedream", provider: "slack", name: "Slack" }),
    ]);
  });
});

it("marks only the authorized connector when provider slugs collide", async () => {
  const { deps, actor, tx } = fixture([]);
  const blocks = ["composio", "pipedream"].map((connectorId) => ({
    kind: "app_connect",
    connectorId,
    provider: "slack",
    name: "Slack",
    status: "pending",
  }));
  deps.prisma.message = { findMany: vi.fn(async () => [{ id: "cards", blocks }]) } as never;
  await markAppConnected(deps, actor, "bot", "slack", "pipedream");
  expect(tx.message.update).toHaveBeenCalledWith({
    where: { id: "cards" },
    data: { blocks: [blocks[0], { ...blocks[1], status: "connected" }] },
  });
});

describe("promptFocus product-mode branch", () => {
  it("posts the focus choice card when productMode is aiden (default)", async () => {
    const { deps, actor } = promptFixture("aiden");
    await promptFocus(deps, actor, "bot");
    expect(posted).toEqual([
      expect.objectContaining({
        blocks: [expect.objectContaining({ kind: "choice" })],
      }),
    ]);
  });

  it("posts the focus choice card when productMode is absent (unset AIDEN_PRODUCT_MODE)", async () => {
    const { deps, actor } = promptFixture(undefined);
    await promptFocus(deps, actor, "bot");
    expect(posted).toEqual([
      expect.objectContaining({
        blocks: [expect.objectContaining({ kind: "choice" })],
      }),
    ]);
  });

  it("posts nothing in muse mode: the web app's first-run welcome introduces the Muse", async () => {
    const { deps, actor } = promptFixture("muse");
    await promptFocus(deps, actor, "bot");
    expect(posted).toEqual([]);
  });
});
