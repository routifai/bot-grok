import { isScratchpadStatus, listScratchpadItems, mapScratchpadItem } from "@nova/adapters";
import { IsolationError } from "@nova/db";
import { ORPCError } from "@orpc/server";

import type { RouterContext } from "./context.js";

export function scratchpadRouter(c: RouterContext) {
  const { authed, repos, deps } = c;
  return {
    scratchpad: {
      list: authed.scratchpad.list.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        return listScratchpadItems(
          { prisma: deps.prisma },
          {
            spaceId: context.actor.spaceId,
            botId: input.botId,
            status: input.status,
            includeDone: input.includeDone ?? false,
          },
        );
      }),
      create: authed.scratchpad.create.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        const row = await deps.prisma.scratchpadItem.create({
          data: {
            spaceId: context.actor.spaceId,
            botId: input.botId,
            userId: context.actor.userId,
            title: input.title.trim(),
            status: input.status,
            notes: input.notes.trim(),
          },
        });
        return mapScratchpadItem(row);
      }),
      update: authed.scratchpad.update.handler(async ({ context, input }) => {
        const existing = await deps.prisma.scratchpadItem.findFirst({
          where: {
            id: input.itemId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (!existing) throw new IsolationError();
        if (input.status !== undefined && !isScratchpadStatus(input.status)) {
          throw new ORPCError("BAD_REQUEST", { message: "Invalid scratchpad status." });
        }
        const row = await deps.prisma.scratchpadItem.update({
          where: { id: existing.id },
          data: {
            ...(input.title !== undefined ? { title: input.title.trim() } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.notes !== undefined ? { notes: input.notes.trim() } : {}),
          },
        });
        return mapScratchpadItem(row);
      }),
      remove: authed.scratchpad.remove.handler(async ({ context, input }) => {
        const existing = await deps.prisma.scratchpadItem.findFirst({
          where: {
            id: input.itemId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (!existing) throw new IsolationError();
        await deps.prisma.scratchpadItem.delete({ where: { id: existing.id } });
        return { ok: true as const };
      }),
    },
  };
}
