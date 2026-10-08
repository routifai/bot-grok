import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { piSessionBotRoot, removePiBotSessions } from "./pi-session.js";

describe("legacy Pi session cleanup", () => {
  it("removes one bot's recorded sessions and leaves the others", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nova-pi-cleanup-"));
    try {
      const sessionsRoot = path.join(root, "pi-sessions");
      const botRoot = piSessionBotRoot(sessionsRoot, "user-1", "bot-1");
      const otherBotRoot = piSessionBotRoot(sessionsRoot, "user-1", "bot-2");
      await mkdir(botRoot, { recursive: true });
      await mkdir(otherBotRoot, { recursive: true });
      await writeFile(path.join(botRoot, "session.jsonl"), "{}\n");
      await writeFile(path.join(otherBotRoot, "session.jsonl"), "{}\n");

      await removePiBotSessions(root, "user-1", "bot-1");
      await expect(readdir(botRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readdir(otherBotRoot)).resolves.toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
