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

  function fakeDeps(toolNames: string[]) {
    const runCreate = vi.fn(async () => ({ id: "run-2" }));
    const prisma: Record<string, unknown> = {
      event: { findMany: vi.fn(async () => toolNames.map((name) => ({ payload: { name } }))) },
      task: { create: vi.fn(async () => ({ id: "task-2" })) },
      run: { create: runCreate },
    };
    prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma);
    const enqueue = vi.fn(async () => undefined);
    return {
      deps: { prisma: prisma as unknown as PrismaClient, jobs: { enqueue } },
      runCreate,
      enqueue,
    };
  }

  it("queues one quiet skill_offer turn when the run only asked in text", async () => {
    const { deps, runCreate, enqueue } = fakeDeps(["web_search", "web_fetch"]);
    expect(await queueSkillOfferFollowUp(deps, run)).toBe(true);
    expect(runCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ trigger: "skill_offer" }) }),
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the run already offered or saved a skill", async () => {
    for (const name of ["offer_skill", "skill_create"]) {
      const { deps, runCreate } = fakeDeps(["web_search", name]);
      expect(await queueSkillOfferFollowUp(deps, run)).toBe(false);
      expect(runCreate).not.toHaveBeenCalled();
    }
  });
});
