import type { Actor } from "@aiden/contracts";
import type { PrismaClient } from "@aiden/db";
import { IsolationError } from "@aiden/db";
import { describe, expect, it, vi } from "vitest";
import { getEngineInfo, setEngineHarness, setEngineRunnerLocation } from "./engine-info.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@aiden.test",
  isDeploymentOwner: true,
};

interface BotRow {
  museHarness: string | null;
  museRunnerLocation: string | null;
}

function depsFor(bot: BotRow | null) {
  const findFirst = vi.fn().mockResolvedValue(bot);
  const update = vi.fn().mockImplementation(async ({ data }: { data: Partial<BotRow> }) => ({
    museHarness: bot?.museHarness ?? null,
    museRunnerLocation: bot?.museRunnerLocation ?? null,
    ...data,
  }));
  const prisma = { bot: { findFirst, update } } as unknown as PrismaClient;
  return { prisma, findFirst, update };
}

const ENABLED_NO_KEYS = { NOVA_ENGINE: "omnigent" };
const ENABLED_ALL_KEYS = {
  NOVA_ENGINE: "omnigent",
  OPENROUTER_API_KEY: "sk-or",
  ANTHROPIC_API_KEY: "sk-ant",
  OPENAI_API_KEY: "sk-openai",
};

describe("getEngineInfo", () => {
  it("reports disabled with a null active harness when NOVA_ENGINE is not omnigent", async () => {
    const { prisma } = depsFor({ museHarness: null, museRunnerLocation: null });
    const info = await getEngineInfo({ prisma }, actor, "bot-1", {});
    expect(info.enabled).toBe(false);
    expect(info.active).toBeNull();
    expect(info.runnerLocation).toBeNull();
    expect(info.harnesses).toHaveLength(4);
  });

  it("defaults active to pi when enabled and the bot has no museHarness", async () => {
    const { prisma } = depsFor({ museHarness: null, museRunnerLocation: null });
    const info = await getEngineInfo({ prisma }, actor, "bot-1", ENABLED_NO_KEYS);
    expect(info.enabled).toBe(true);
    expect(info.active).toBe("pi");
  });

  it("follows OMNIGENT_AGENT_NAME's harness for backwards compatibility when unset", async () => {
    const { prisma } = depsFor({ museHarness: null, museRunnerLocation: null });
    const info = await getEngineInfo({ prisma }, actor, "bot-1", {
      ...ENABLED_NO_KEYS,
      OMNIGENT_AGENT_NAME: "nova-claude",
    });
    expect(info.active).toBe("claude");
  });

  it("reports the bot's own chosen harness when set", async () => {
    const { prisma } = depsFor({ museHarness: "codex", museRunnerLocation: null });
    const info = await getEngineInfo({ prisma }, actor, "bot-1", ENABLED_NO_KEYS);
    expect(info.active).toBe("codex");
  });

  it("reports availability for each harness from env", async () => {
    const { prisma } = depsFor({ museHarness: null, museRunnerLocation: null });
    const info = await getEngineInfo({ prisma }, actor, "bot-1", ENABLED_ALL_KEYS);
    for (const harness of info.harnesses) {
      expect(harness.available).toBe(true);
      expect(harness.unavailableReason).toBeNull();
    }
  });

  it("names the missing env var when a harness is unavailable", async () => {
    const { prisma } = depsFor({ museHarness: null, museRunnerLocation: null });
    const info = await getEngineInfo({ prisma }, actor, "bot-1", ENABLED_NO_KEYS);
    const claude = info.harnesses.find((h) => h.id === "claude");
    expect(claude).toMatchObject({
      available: false,
      unavailableReason: "Add ANTHROPIC_API_KEY to .env",
    });
  });

  it("defaults runnerLocation to computer when enabled and the bot has no choice", async () => {
    const { prisma } = depsFor({ museHarness: null, museRunnerLocation: null });
    const info = await getEngineInfo({ prisma }, actor, "bot-1", ENABLED_NO_KEYS);
    expect(info.runnerLocation).toBe("computer");
  });

  it("reports the bot's own chosen runner location when set", async () => {
    const { prisma } = depsFor({ museHarness: null, museRunnerLocation: "local" });
    const info = await getEngineInfo({ prisma }, actor, "bot-1", ENABLED_NO_KEYS);
    expect(info.runnerLocation).toBe("local");
  });

  it("rejects a bot outside the actor's space", async () => {
    const { prisma } = depsFor(null);
    await expect(
      getEngineInfo({ prisma }, actor, "someone-elses-bot", ENABLED_NO_KEYS),
    ).rejects.toBeInstanceOf(IsolationError);
  });
});

describe("setEngineHarness", () => {
  it("rejects when Nova is not running on the Omnigent engine", async () => {
    const { prisma, update } = depsFor({ museHarness: null, museRunnerLocation: null });
    await expect(
      setEngineHarness({ prisma }, actor, { botId: "bot-1", harness: "claude" }, {}),
    ).rejects.toThrow(/not running on the Omnigent engine/);
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects a bot outside the actor's space", async () => {
    const { prisma, update } = depsFor(null);
    await expect(
      setEngineHarness(
        { prisma },
        actor,
        { botId: "someone-elses-bot", harness: "claude" },
        ENABLED_ALL_KEYS,
      ),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects an unavailable harness with a clear error naming the missing variable", async () => {
    const { prisma, update } = depsFor({ museHarness: null, museRunnerLocation: null });
    await expect(
      setEngineHarness({ prisma }, actor, { botId: "bot-1", harness: "claude" }, ENABLED_NO_KEYS),
    ).rejects.toThrow(/Add ANTHROPIC_API_KEY to \.env/);
    expect(update).not.toHaveBeenCalled();
  });

  it("persists an available harness choice and returns the refreshed info", async () => {
    const { prisma, update } = depsFor({ museHarness: null, museRunnerLocation: null });
    const info = await setEngineHarness(
      { prisma },
      actor,
      { botId: "bot-1", harness: "codex" },
      ENABLED_ALL_KEYS,
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: "bot-1" },
      data: { museHarness: "codex" },
      select: { museHarness: true, museRunnerLocation: true },
    });
    expect(info.active).toBe("codex");
  });
});

describe("setEngineRunnerLocation", () => {
  it("rejects when Nova is not running on the Omnigent engine", async () => {
    const { prisma, update } = depsFor({ museHarness: null, museRunnerLocation: null });
    await expect(
      setEngineRunnerLocation({ prisma }, actor, { botId: "bot-1", runnerLocation: "local" }, {}),
    ).rejects.toThrow(/not running on the Omnigent engine/);
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects a bot outside the actor's space", async () => {
    const { prisma, update } = depsFor(null);
    await expect(
      setEngineRunnerLocation(
        { prisma },
        actor,
        { botId: "someone-elses-bot", runnerLocation: "local" },
        ENABLED_ALL_KEYS,
      ),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(update).not.toHaveBeenCalled();
  });

  it("persists the chosen runner location and returns the refreshed info", async () => {
    const { prisma, update } = depsFor({ museHarness: null, museRunnerLocation: null });
    const info = await setEngineRunnerLocation(
      { prisma },
      actor,
      { botId: "bot-1", runnerLocation: "local" },
      ENABLED_NO_KEYS,
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: "bot-1" },
      data: { museRunnerLocation: "local" },
      select: { museHarness: true, museRunnerLocation: true },
    });
    expect(info.runnerLocation).toBe("local");
  });
});
