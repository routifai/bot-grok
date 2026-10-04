import { describe, expect, it, vi } from "vitest";

const takeover = vi.fn(async () => ({ leaseId: "engine", expiresAt: "" }));
const release = vi.fn(async () => ({ ok: true as const }));
const provision = vi.fn();
vi.mock("./engine-computer.js", () => ({
  engineComputerClient: () => ({ baseUrl: "http://omnigent.test" }),
  engineComputerTakeover: takeover,
  engineComputerRelease: release,
}));
vi.mock("@aiden/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aiden/adapters")>()),
  provisionComputer: provision,
}));

const { createTaughtSkillsService } = await import("./taught-skills.js");

const actor = { userId: "user-1", spaceId: "space-1" } as never;

function setup(row?: Record<string, unknown>) {
  const created = { ...row };
  const prisma = {
    bot: {
      // A Pi-era Computer row with a dead container: the engine path must never look at it.
      findFirst: vi.fn(async () => ({
        id: "bot-1",
        thread: null,
        computer: { id: "c1", kind: "docker", state: "stopped", providerRef: "dead" },
      })),
      findUnique: vi.fn(async () => ({ id: "bot-1", thread: null, computer: null })),
    },
    taughtSkill: {
      findFirst: vi.fn(async () => (row ? created : null)),
      findUnique: vi.fn(async () => created),
      findUniqueOrThrow: vi.fn(async () => created),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "skill-1",
        name: "",
        createdAt: new Date(),
        updatedAt: new Date(),
        stoppedAt: null,
        ...data,
      })),
    },
    run: { findMany: vi.fn(async () => []), updateMany: vi.fn() },
    computer: { updateMany: vi.fn() },
    computerExecutionLease: { updateMany: vi.fn() },
    event: { deleteMany: vi.fn() },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  const jobs = { enqueue: vi.fn(), cancel: vi.fn() };
  const service = createTaughtSkillsService({
    prisma: prisma as never,
    events: { append: vi.fn(), notify: vi.fn() } as never,
    jobs: jobs as never,
    sandbox: {} as never,
    home: {} as never,
    dataDir: "/tmp",
  });
  return { service, prisma, jobs };
}

describe("teaching on the engine's Computer", () => {
  it("start takes engine control and never provisions or leases Nova's Computer row", async () => {
    const { service, prisma } = setup();
    const skill = await service.start(actor, "bot-1", "file expenses");
    expect(takeover).toHaveBeenCalledWith(expect.anything(), expect.anything(), actor, "bot-1");
    expect(provision).not.toHaveBeenCalled();
    expect(prisma.computer.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ controlHolder: "user" }) }),
    );
    expect(skill.recording.controlLeaseId).toBe("engine");
  });

  it("stop releases engine control", async () => {
    release.mockClear();
    const recording = { events: [], snapshots: [], controlLeaseId: "engine" };
    const { service } = setup({
      id: "skill-1",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      status: "saved",
      goal: "g",
      name: "n",
      playbook: {},
      recording,
      startedAt: null,
      expiresAt: null,
      stoppedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await service.stop(actor, "skill-1");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
