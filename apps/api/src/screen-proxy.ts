import { timingSafeEqual } from "node:crypto";
import { hasActiveComputerControl } from "@aiden/adapters";
import type { ScreenCapabilityScope } from "@aiden/core/node/screen-capability";
import {
  ENGINE_COMPUTER_ID,
  openScreenCapability,
  SCREEN_TARGET_ENDPOINT,
  sealScreenCapability,
} from "@aiden/core/node/screen-capability";
import type { PrismaClient } from "@aiden/db";
import type { Hono } from "hono";
import { requestBodyLimit } from "./request-body-limit.js";

export function addScreenProxyCapability(
  url: string,
  secret: string,
  origin: string,
  scope: ScreenCapabilityScope,
  now = Date.now(),
) {
  // Local/desktop providers return non-http schemes (e.g. desktop://). Those never
  // traverse the web proxy, so seal only http(s) upstream URLs.
  const protocol = new URL(url).protocol;
  if (protocol !== "http:" && protocol !== "https:") return url;
  return sealScreenCapability(url, secret, origin, scope, now);
}

export function mountScreenTarget(app: Hono, prisma: PrismaClient, secret: string) {
  app.post(SCREEN_TARGET_ENDPOINT, requestBodyLimit(16 * 1024), async (c) => {
    c.header("cache-control", "no-store");
    const supplied = Buffer.from(c.req.header("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${secret}`);
    if (!secret || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return c.body(null, 403);
    const body = await c.req.json().catch(() => null);
    if (typeof body?.path !== "string") return c.body(null, 403);
    const capability = openScreenCapability(body.path, secret);
    if (!capability) return c.body(null, 403);
    const { scope, target } = capability;
    if (scope.computerId === ENGINE_COMPUTER_ID) {
      // The engine owns this Computer and its screen token: only check the Muse is still ours.
      const engineBot = await prisma.bot.findFirst({
        where: { id: scope.botId, archivedAt: null, screenGeneration: scope.botGeneration },
        select: { id: true },
      });
      return engineBot ? c.json(target) : c.body(null, 403);
    }
    const bot = await prisma.bot.findFirst({
      where: {
        id: scope.botId,
        computerId: scope.computerId,
        archivedAt: null,
        screenGeneration: scope.botGeneration,
      },
      select: {
        computer: {
          select: {
            screenGeneration: true,
            providerRef: true,
            state: true,
            controlHolder: true,
            controlLeaseId: true,
            controlBotId: true,
            controlLeaseExpiresAt: true,
          },
        },
      },
    });
    const computer = bot?.computer;
    if (
      !computer ||
      computer.screenGeneration !== scope.computerGeneration ||
      !computer.providerRef ||
      !["running", "booting"].includes(computer.state) ||
      (target.interactive &&
        (!hasActiveComputerControl(computer) ||
          !scope.controlLeaseId ||
          computer.controlLeaseId !== scope.controlLeaseId ||
          computer.controlBotId !== scope.botId))
    )
      return c.body(null, 403);
    return c.json(target);
  });
}
