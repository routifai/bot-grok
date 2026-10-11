import { ORPCError } from "@orpc/server";
import type { SandboxProvider } from "@superchat/adapter-kit";
import {
  displayBotWorkspacePath,
  resolveBotWorkspacePath,
  scheduleComputerSleep,
  toComputerRef,
  touchRunningComputer,
} from "@superchat/adapters";
import { IsolationError, parseComputerMode } from "@superchat/db";
import type { RouterContext } from "../../routers/context.js";
import { computerContext } from "../../routers/shared.js";

const MAX_COMPUTER_TEXT_FILE_BYTES = 2 * 1024 * 1024;

export function computerWorkspaceProcedures(c: RouterContext) {
  const { deps, authed, repos } = c;
  return {
    files: authed.computer.files.handler(async ({ context, input }) => {
      const bot = await repos.getBot(context.actor, input.botId);
      if (!bot.computer) throw new IsolationError();
      const computer = bot.computer;
      const computerMode = parseComputerMode(computer.scope);
      const ctx = computerContext(context.actor, bot.id, "files");
      const storedPath = resolveBotWorkspacePath(computerMode, bot.id, input.path);
      let entries: Awaited<ReturnType<SandboxProvider["listFiles"]>>;
      if (computer.state === "running" && computer.providerRef) {
        await deps.prisma.computer.updateMany({
          where: { id: computer.id, state: "running" },
          data: { updatedAt: new Date() },
        });
        scheduleComputerSleep(deps.jobs, computer.id);
        entries = await deps.sandbox.listFiles(toComputerRef(computer), storedPath, ctx);
      } else {
        entries = await deps.home.list(computer.homeKey, storedPath, ctx);
      }
      return entries.map((entry) => ({
        ...entry,
        path: displayBotWorkspacePath(computerMode, bot.id, input.path, entry.path),
      }));
    }),
    readFile: authed.computer.readFile.handler(async ({ context, input }) => {
      const bot = await repos.getBot(context.actor, input.botId);
      if (!bot.computer) throw new IsolationError();
      const computerMode = parseComputerMode(bot.computer.scope);
      const ctx = computerContext(context.actor, bot.id, "read");
      const storedPath = resolveBotWorkspacePath(computerMode, bot.id, input.path);
      let content: string;
      if (bot.computer.state === "running" && bot.computer.providerRef) {
        await deps.prisma.computer.updateMany({
          where: { id: bot.computer.id, state: "running" },
          data: { updatedAt: new Date() },
        });
        scheduleComputerSleep(deps.jobs, bot.computer.id);
        const bytes = await deps.sandbox.readFile(toComputerRef(bot.computer), storedPath, ctx, {
          maxBytes: MAX_COMPUTER_TEXT_FILE_BYTES,
        });
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } else {
        try {
          content = await deps.home.readFile(bot.computer.homeKey, storedPath, ctx, {
            maxBytes: MAX_COMPUTER_TEXT_FILE_BYTES,
          });
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("agent home file exceeds ")) {
            throw new ORPCError("BAD_REQUEST", { message: "file is too large to preview" });
          }
          throw error;
        }
      }
      return { path: input.path, content };
    }),
    heartbeat: authed.computer.heartbeat.handler(async ({ context, input }) => {
      const bot = await repos.getBot(context.actor, input.botId);
      if (bot.computer?.state === "running" && bot.computer.providerRef) {
        await deps.prisma.computer.updateMany({
          where: { id: bot.computer.id, state: "running" },
          data: { updatedAt: new Date() },
        });
        await touchRunningComputer(
          { sandbox: deps.sandbox, jobs: deps.jobs },
          {
            id: bot.computer.id,
            homeKey: bot.computer.homeKey,
            providerRef: bot.computer.providerRef,
            kind: bot.computer.kind,
          },
        ).catch(() => undefined);
      }
      return { ok: true as const };
    }),
  };
}
