import type { PrismaClient } from "@aiden/db";
import { describe, expect, it, vi } from "vitest";
import { queueSkillOfferFollowUp, replyAsksToSaveSkill } from "./skill-offer-followup.js";

describe("replyAsksToSaveSkill", () => {
  it("spots a reply that ends by asking to save the work as a skill", () => {
    expect(
      replyAsksToSaveSkill(
        "| RBC | 5.04% |\n\nThis was multi-step research. Want me to save it as a reusable skill so you can ask again next time?",
      ),
    ).toBe(true);
  });

  it("ignores replies that don't ask, or mention skills without asking to save", () => {
    expect(replyAsksToSaveSkill("Here are the rates.")).toBe(false);
    expect(replyAsksToSaveSkill("I used your saved skill for this.")).toBe(false);
    expect(replyAsksToSaveSkill("Want me to save the table to a file?")).toBe(false);
  });
});

describe("queueSkillOfferFollowUp", () => {
  const run = { id: "run-1", spaceId: "s", botId: "b", threadId: "t", userId: "u" };

  function fakeDeps(toolNames: string[], options: { recentOffer?: boolean } = {}) {
    const runCreate = vi.fn(async () => ({ id: "run-2" }));
    const taskCreate = vi.fn(async (_args: { data: { prompt: string } }) => ({ id: "task-2" }));
    const prisma: Record<string, unknown> = {
      event: { findMany: vi.fn(async () => toolNames.map((name) => ({ payload: { name } }))) },
      task: { create: taskCreate },
      run: {
        create: runCreate,
        findFirst: vi.fn(async () => (options.recentOffer ? { id: "run-0" } : null)),
      },
    };
    prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma);
    const enqueue = vi.fn(async () => undefined);
    return {
      deps: { prisma: prisma as unknown as PrismaClient, jobs: { enqueue } },
      runCreate,
      taskCreate,
      enqueue,
    };
  }

  it("reviews multi-step work with a quiet skill_offer turn", async () => {
    const { deps, runCreate, taskCreate, enqueue } = fakeDeps([
      "web_search",
      "web_fetch",
      "web_search",
    ]);
    expect(await queueSkillOfferFollowUp(deps, run, { askedInText: false })).toBe(true);
    expect(runCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ trigger: "skill_offer" }) }),
    );
    expect(taskCreate.mock.calls[0]?.[0].data.prompt).toContain("likely ask for again");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("makes the real offer when the reply only asked in text, even for short work", async () => {
    const { deps, taskCreate } = fakeDeps(["web_search"]);
    expect(await queueSkillOfferFollowUp(deps, run, { askedInText: true })).toBe(true);
    expect(taskCreate.mock.calls[0]?.[0].data.prompt).toContain("asked in text");
  });

  it("skips short work, runs that already handled a skill, and recent offers", async () => {
    expect(
      await queueSkillOfferFollowUp(fakeDeps(["web_search"]).deps, run, { askedInText: false }),
    ).toBe(false);
    for (const name of ["offer_skill", "skill_create", "skill_read"]) {
      const { deps, runCreate } = fakeDeps(["web_search", "web_fetch", "web_search", name]);
      expect(await queueSkillOfferFollowUp(deps, run, { askedInText: true })).toBe(false);
      expect(runCreate).not.toHaveBeenCalled();
    }
    const cooling = fakeDeps(["web_search", "web_fetch", "web_search"], { recentOffer: true });
    expect(await queueSkillOfferFollowUp(cooling.deps, run, { askedInText: false })).toBe(false);
  });
});
