import { describe, expect, it, vi } from "vitest";

const takeover = vi.fn(async () => ({ leaseId: "engine", expiresAt: "" }));
const release = vi.fn(async () => ({ ok: true as const }));
vi.mock("../computer/index.js", () => ({
  engineComputerTakeover: takeover,
  engineComputerRelease: release,
}));
vi.mock("../../engine-client.js", () => ({
  engineComputerClient: () => ({ baseUrl: "http://omnigent.test" }),
  engineSessionOf: vi.fn(async () => ({ email: "me@example.test", sessionId: "sess-1" })),
}));

const engine = {
  startOmnigentRecording: vi.fn(async () => ({ recording_id: "rec-1", skill_id: "skill-1" })),
  stopOmnigentRecording: vi.fn(async () => ({ recording_id: "rec-1", skill_id: "skill-1" })),
  getOmnigentTaughtSkill: vi.fn(),
  listOmnigentTaughtSkills: vi.fn(async () => []),
  getOmnigentSkillKeyframe: vi.fn(async (_c: unknown, _e: string, _id: string, name: string) =>
    name === "k1" ? "data:image/jpeg;base64,AAA" : null,
  ),
  putOmnigentTaughtSkillDoc: vi.fn(),
  saveOmnigentTaughtSkill: vi.fn(),
  renderOmnigentTaughtSkill: vi.fn(async () => ({
    skill_id: "skill-1",
    name: "Search",
    text: "1. Search for desk lamp",
    missing_inputs: [],
  })),
  deleteOmnigentTaughtSkill: vi.fn(async () => undefined),
  emitSkillDraftMessages: vi.fn(async () => undefined),
};
vi.mock("@nova/adapters", () => engine);

const { createTaughtSkillsService } = await import("./taught-skills.js");

const actor = { userId: "user-1", spaceId: "space-1" } as never;
const doc = {
  name: "Search",
  goal: "Find a product",
  preconditions: ["On the shop"],
  inputs: [{ name: "product", label: "Product", default: "laptop stand" }],
  steps: [
    { intent: "Search for {{product}}", check: "Results", approval: false, keyframe: "k1" },
    { intent: "Buy it", check: "Receipt", approval: true, keyframe: "k9" },
  ],
  returns: "The price",
};
const engineSkill = (over: Record<string, unknown> = {}) => ({
  id: "skill-1",
  parent_session_id: "sess-1",
  recording_id: "rec-1",
  name: "Search",
  goal: "Find a product",
  status: "draft",
  version: 1,
  doc,
  created_at: 1_700_000_000,
  updated_at: null,
  stopped_at: 1_700_000_100,
  ...over,
});

function setup({ linked = true }: { linked?: boolean } = {}) {
  const prisma = {
    user: { findUnique: vi.fn(async () => ({ email: "me@example.test" })) },
    omnigentSession: { findFirst: vi.fn(async () => (linked ? { botId: "bot-1" } : null)) },
    bot: {
      findFirst: vi.fn(async () => ({ id: "bot-1", thread: { id: "t-1" } })),
      findUnique: vi.fn(async () => ({ id: "bot-1", spaceId: "space-1", thread: { id: "t-1" } })),
    },
    message: { findMany: vi.fn(async () => []), update: vi.fn() },
    run: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(),
      create: vi.fn(async () => ({ id: "run-1" })),
    },
    task: { create: vi.fn(async () => ({ id: "task-1" })) },
    event: { deleteMany: vi.fn() },
  };
  const events = { append: vi.fn(), notify: vi.fn() };
  const jobs = { enqueue: vi.fn(), cancel: vi.fn() };
  const service = createTaughtSkillsService({
    prisma: prisma as never,
    events: events as never,
    jobs: jobs as never,
  });
  return { prisma, events, jobs, service };
}

describe("teaching on the engine", () => {
  it("takes over, then records; the skill is the engine's", async () => {
    const { service, events } = setup();
    engine.getOmnigentTaughtSkill.mockResolvedValueOnce(
      engineSkill({ status: "recording", doc: null }),
    );
    const skill = await service.start(actor, "bot-1", "search a product");
    expect(takeover).toHaveBeenCalled();
    expect(engine.startOmnigentRecording).toHaveBeenCalledWith(
      expect.anything(),
      "me@example.test",
      "sess-1",
      "search a product",
    );
    expect(skill).toMatchObject({ id: "skill-1", botId: "bot-1", status: "recording" });
    expect(skill.recording.controlLeaseId).toBe("engine");
    expect(events.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "skill.teaching.started" }),
    );
  });

  it("hands control back when the recording cannot start", async () => {
    const { service } = setup();
    release.mockClear();
    engine.startOmnigentRecording.mockRejectedValueOnce(new Error("no browser"));
    await expect(service.start(actor, "bot-1", "x")).rejects.toThrow("no browser");
    expect(release).toHaveBeenCalled();
  });

  it("stop ends the recording, releases control and drops a draft card in the thread", async () => {
    const { service, events } = setup();
    release.mockClear();
    engine.getOmnigentTaughtSkill
      .mockResolvedValueOnce(engineSkill({ status: "recording", doc: null }))
      .mockResolvedValueOnce(engineSkill({ status: "drafting", doc: null }));
    const skill = await service.stop(actor, "skill-1");
    expect(engine.stopOmnigentRecording).toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
    expect(skill.status).toBe("drafting");
    expect(engine.emitSkillDraftMessages).toHaveBeenCalled();
    expect(events.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "skill.teaching.stopped" }),
    );
  });

  it("get maps the draft and inlines the keyframes its steps use", async () => {
    const { service } = setup();
    engine.getOmnigentTaughtSkill.mockResolvedValueOnce(engineSkill());
    const skill = await service.get(actor, "skill-1");
    expect(skill.draft?.steps).toHaveLength(2);
    expect(skill.draft?.inputs[0]).toMatchObject({ name: "product", default: "laptop stand" });
    expect(skill.keyframes).toEqual({ k1: "data:image/jpeg;base64,AAA" });
    expect(skill.playbook.steps).toEqual(["Search for {{product}}", "Buy it"]);
    expect(skill.playbook.approvalBoundaries).toContain("Buy it");
  });

  it("refuses a skill of someone else's Muse", async () => {
    const { service } = setup({ linked: false });
    engine.getOmnigentTaughtSkill.mockResolvedValueOnce(engineSkill());
    await expect(service.get(actor, "skill-1")).rejects.toThrow();
  });

  it("maps an engine invalid or missing skill id to NOT_FOUND, not a 500", async () => {
    const { service } = setup();
    for (const code of ["invalid_input", "not_found"]) {
      engine.getOmnigentTaughtSkill.mockRejectedValueOnce(Object.assign(new Error("x"), { code }));
      await expect(service.get(actor, "legacy-id")).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("edits write a new engine version; save keeps it", async () => {
    const { service } = setup();
    engine.getOmnigentTaughtSkill.mockResolvedValue(engineSkill());
    engine.putOmnigentTaughtSkillDoc.mockImplementation(
      async (_c: unknown, _e: string, _id: string, next: unknown) =>
        engineSkill({ doc: next, name: (next as { name: string }).name }),
    );
    const edited = await service.updateDraft(actor, "skill-1", {
      name: "Find a price",
      draft: { ...doc, steps: [doc.steps[0] as (typeof doc.steps)[number]] },
    });
    expect(engine.putOmnigentTaughtSkillDoc.mock.calls[0]?.[3]).toMatchObject({
      name: "Find a price",
      goal: "Find a product",
    });
    expect(edited.draft?.steps).toHaveLength(1);

    engine.saveOmnigentTaughtSkill.mockResolvedValueOnce(engineSkill({ status: "saved" }));
    const saved = await service.save(actor, "skill-1", "Search");
    expect(engine.putOmnigentTaughtSkillDoc).toHaveBeenCalledTimes(1);
    expect(saved.status).toBe("saved");
  });

  it("test run is an ordinary turn carrying the rendered skill and inputs", async () => {
    const { service, prisma, jobs } = setup();
    engine.getOmnigentTaughtSkill.mockResolvedValue(engineSkill());
    const result = await service.testRun(actor, "skill-1", { inputs: { product: "desk lamp" } });
    expect(engine.renderOmnigentTaughtSkill).toHaveBeenCalledWith(
      expect.anything(),
      "me@example.test",
      "skill-1",
      { product: "desk lamp" },
    );
    const data = (prisma.task.create.mock.calls[0] as unknown as [{ data: { prompt: string } }])[0]
      .data;
    expect(data.prompt).toContain("1. Search for desk lamp");
    expect(data.prompt).toContain("do not send, spend, delete or publish");
    expect(result).toEqual({ runId: "run-1" });
    expect(jobs.enqueue).toHaveBeenCalled();
  });

  it("remove deletes on the engine", async () => {
    const { service } = setup();
    engine.getOmnigentTaughtSkill.mockResolvedValue(engineSkill());
    expect(await service.remove(actor, "skill-1")).toEqual({ ok: true });
    expect(engine.deleteOmnigentTaughtSkill).toHaveBeenCalledWith(
      expect.anything(),
      "me@example.test",
      "skill-1",
    );
  });
});
