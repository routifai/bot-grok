import type { PrismaClient } from "@aiden/db";
import { describe, expect, it, vi } from "vitest";
import { MUSE_ONLY_TOOL_NAMES } from "../executor/run-tools.js";
import { offerSkillFromTool } from "./skill-offer.js";

const scope = { spaceId: "space-1", botId: "bot-1", userId: "user-1", runId: "run-1" };
const CONTENT =
  "---\nname: weekly-rate-watch\ndescription: Quick update on Canadian rates.\n---\n\n1. Search the policy rate.";

function fakeDeps(options: { existing?: boolean } = {}) {
  const messageCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "msg-1",
    ...data,
  }));
  const prisma: Record<string, unknown> = {
    agentSkill: {
      findFirst: vi.fn(async () => (options.existing ? { name: "weekly-rate-watch" } : null)),
    },
    thread: {
      findUnique: vi.fn(async () => ({ id: "conv-1" })),
      update: vi.fn(async () => ({ nextEventSeq: 7 })),
    },
    message: { create: messageCreate },
    run: { findUnique: vi.fn(async () => ({ status: "running", startedAt: new Date() })) },
    event: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "e", ...data })),
    },
  };
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma);
  const notify = vi.fn(async () => undefined);
  return {
    deps: { prisma: prisma as unknown as PrismaClient, events: { notify } },
    messageCreate,
    notify,
  };
}

describe("offerSkillFromTool", () => {
  it("posts a Save / Not now Ask in the Conversation carrying the skill", async () => {
    const { deps, messageCreate, notify } = fakeDeps();

    const result = await offerSkillFromTool(deps, scope, {
      content: CONTENT,
      why: "You ask weekly.",
    });

    expect(result).toMatchObject({ ok: true, offered: "weekly-rate-watch" });
    const created = messageCreate.mock.calls[0]?.[0].data as { threadId: string; blocks: unknown };
    expect(created.threadId).toBe("conv-1");
    expect(created.blocks).toEqual([
      expect.objectContaining({
        kind: "ask",
        status: "pending",
        text: 'Save "weekly-rate-watch" as a skill?',
        actions: [
          { id: "save", label: "Save skill" },
          { id: "dismiss", label: "Not now" },
        ],
        skillOffer: expect.objectContaining({ name: "weekly-rate-watch" }),
      }),
    ]);
    expect(notify).toHaveBeenCalled();
  });

  it("rejects a SKILL.md without frontmatter", async () => {
    const { deps, messageCreate } = fakeDeps();
    const result = await offerSkillFromTool(deps, scope, { content: "1. Search." });
    expect(result).toHaveProperty("error");
    expect(messageCreate).not.toHaveBeenCalled();
  });

  it("does not offer a skill that is already saved", async () => {
    const { deps, messageCreate } = fakeDeps({ existing: true });
    const result = await offerSkillFromTool(deps, scope, { content: CONTENT });
    expect(String(result.error)).toContain("already saved");
    expect(messageCreate).not.toHaveBeenCalled();
  });

  it("is a Muse-only tool", () => {
    expect(MUSE_ONLY_TOOL_NAMES.has("offer_skill")).toBe(true);
  });
});
