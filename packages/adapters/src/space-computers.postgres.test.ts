import {
  bootstrapUserSpace,
  claimQuarantinedForPurge,
  createDb,
  quarantineUserSpaces,
  releasePurgeClaim,
  restoreQuarantinedSpaces,
} from "@nova/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import {
  identityMaintenance,
  purgeQuarantinedOrganizations,
  resetIdentityMaintenance,
  retryQuarantinedStops,
  stopSpaceComputers,
} from "./space-computers.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;

describePostgres("quarantine of a used space (PostgreSQL, fake sandbox)", () => {
  const { prisma, pool } = createDb(databaseUrl ?? "postgres://unused");
  const sandbox = new FakeSandboxProvider();
  const tag = `${process.pid}-${Date.now()}`;
  const ctx = {
    operationId: "t",
    traceId: "t",
    spaceId: "",
    userId: "",
    signal: new AbortController().signal,
  };
  const created: string[] = [];

  async function usedAccount(name: string) {
    const id = `q-${name}-${tag}`;
    created.push(id);
    await prisma.user.create({
      data: { id, name, email: `${id}@example.test`, emailVerified: false },
    });
    const { spaceId } = await bootstrapUserSpace(
      prisma,
      { id },
      {},
      { claimDeploymentOwner: false },
    );
    const ref = await sandbox.provision({ botId: `team:${spaceId}`, homePath: "/tmp/x" }, ctx);
    await prisma.computer.create({
      data: {
        spaceId,
        userId: id,
        scope: "team",
        scopeKey: `team:${spaceId}`,
        homeKey: ref.botId,
        kind: ref.kind,
        providerRef: ref.providerRef,
        state: "running",
      },
    });
    await prisma.secret
      .create({
        data: {
          id: `sec-${id}`,
          userId: id,
          spaceId,
          name: "k",
          kind: "api",
          cipher: "x",
        } as never,
      })
      .catch(() => undefined);
    await prisma.messagingIdentity.create({
      data: { provider: "telegram", address: `a-${id}`, userId: id, spaceId, botId: `bot-${id}` },
    });
    return { id, spaceId };
  }

  afterAll(async () => {
    for (const id of created) {
      await prisma.organization.deleteMany({
        where: { id: { startsWith: "" }, quarantinedFromUserId: id },
      });
      await prisma.user.deleteMany({ where: { id } });
    }
    await prisma.$disconnect();
    await pool?.end();
  });

  beforeAll(() => resetIdentityMaintenance());

  it("stops the Computer, strips access, detaches the space and keeps it; restore gives it back", async () => {
    const { id, spaceId } = await usedAccount("restore");
    await stopSpaceComputers({ prisma, sandbox }, [spaceId], "t");
    expect([...sandbox.boxes.values()].every((box) => !box.running)).toBe(true);
    const { organizationIds } = await quarantineUserSpaces(prisma, id);
    expect(organizationIds).toHaveLength(1);
    expect(await prisma.messagingIdentity.count({ where: { userId: id } })).toBe(0);
    expect(await prisma.spaceMember.count({ where: { userId: id } })).toBe(0);
    expect(await prisma.space.count({ where: { id: spaceId } })).toBe(1);
    expect(await prisma.computer.count({ where: { spaceId } })).toBe(1);
    expect(await prisma.organization.count({ where: { quarantinedFromUserId: id } })).toBe(1);

    expect(await restoreQuarantinedSpaces(prisma, id)).toBe(1);
    expect(await prisma.spaceMember.count({ where: { userId: id, spaceId } })).toBe(1);
    expect(await prisma.organization.count({ where: { quarantinedFromUserId: id } })).toBe(0);
  });

  it("discard destroys the team Computer through the provider, then removes the space", async () => {
    const { id, spaceId } = await usedAccount("discard");
    await quarantineUserSpaces(prisma, id);
    const boxesBefore = sandbox.boxes.size;
    const organizations = await prisma.organization.findMany({
      where: { quarantinedFromUserId: id },
      select: { id: true, spaces: { select: { id: true } } },
    });
    await purgeQuarantinedOrganizations({ prisma, sandbox }, organizations);
    expect(sandbox.boxes.size).toBe(boxesBefore - 1);
    expect(await prisma.space.count({ where: { id: spaceId } })).toBe(0);
    expect(await prisma.computer.count({ where: { spaceId } })).toBe(0);
  });

  it("purges only quarantined spaces past the TTL, and drops stale counters, once an hour", async () => {
    const old = await usedAccount("old");
    const fresh = await usedAccount("fresh");
    const day = 24 * 60 * 60 * 1000;
    await quarantineUserSpaces(prisma, old.id, new Date(Date.now() - 31 * day));
    await quarantineUserSpaces(prisma, fresh.id, new Date(Date.now() - 5 * day));
    await prisma.$executeRaw`INSERT INTO email_quota (key, count, "windowStart") VALUES (${`stale-${tag}`}, 1, ${Date.now() - 3 * day}), (${`live-${tag}`}, 1, ${Date.now()}) ON CONFLICT DO NOTHING`;
    resetIdentityMaintenance();
    await identityMaintenance({ prisma, sandbox });
    expect(await prisma.space.count({ where: { id: old.spaceId } })).toBe(0);
    expect(await prisma.space.count({ where: { id: fresh.spaceId } })).toBe(1);
    const left = await prisma.$queryRaw<
      Array<{ key: string }>
    >`SELECT key FROM email_quota WHERE key LIKE ${`%-${tag}`}`;
    expect(left.map((row) => row.key)).toEqual([`live-${tag}`]);
    // A second tick within the hour does nothing.
    await prisma.$executeRaw`DELETE FROM email_quota WHERE key LIKE ${`%-${tag}`}`;
  });

  it("bumps screen generations in one transaction with the detach, so old links die even after a restore", async () => {
    const { id, spaceId } = await usedAccount("screens");
    const botId = `screen-bot-${tag}`;
    await prisma.bot
      .create({
        data: { id: botId, spaceId, userId: id, name: "Nova", screenGeneration: 3 } as never,
      })
      .catch(() => undefined);
    const before = await prisma.computer.findFirstOrThrow({ where: { spaceId } });
    await quarantineUserSpaces(prisma, id);
    const after = await prisma.computer.findFirstOrThrow({ where: { spaceId } });
    expect(after.screenGeneration).toBe(before.screenGeneration + 1);
    expect(after.screenUrl).toBeNull();
    const bot = await prisma.bot.findUnique({ where: { id: botId } });
    if (bot) expect(bot.screenGeneration).toBe(4);
    await restoreQuarantinedSpaces(prisma, id);
    const restored = await prisma.computer.findFirstOrThrow({ where: { spaceId } });
    expect(restored.screenGeneration).toBe(after.screenGeneration);
    const user = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(user.engineQuarantinePaused).toBe(true);
  });

  it("lets only one of restore and purge win a quarantined space", async () => {
    const a = await usedAccount("race-a");
    await quarantineUserSpaces(prisma, a.id);
    const [org] = await prisma.organization.findMany({
      where: { quarantinedFromUserId: a.id },
      select: { id: true, spaces: { select: { id: true } } },
    });
    // The purge claims first: a restore then finds nothing, and the space is not re-attached.
    // The claim keeps who the space belonged to, so a retried discard still finds it.
    expect(await claimQuarantinedForPurge(prisma, org!.id)).toBe(true);
    expect(await claimQuarantinedForPurge(prisma, org!.id)).toBe(false); // one purge at a time
    expect(await prisma.organization.count({ where: { quarantinedFromUserId: a.id } })).toBe(1);
    expect(await restoreQuarantinedSpaces(prisma, a.id)).toBe(0);
    await releasePurgeClaim(prisma, org!.id); // a failed purge lets go
    expect(await prisma.spaceMember.count({ where: { userId: a.id } })).toBe(0);
    await purgeQuarantinedOrganizations({ prisma, sandbox }, [org!]);
    expect(await prisma.organization.count({ where: { id: org!.id } })).toBe(0);

    const b = await usedAccount("race-b");
    await quarantineUserSpaces(prisma, b.id);
    const [orgB] = await prisma.organization.findMany({
      where: { quarantinedFromUserId: b.id },
      select: { id: true, spaces: { select: { id: true } } },
    });
    // The restore claims first: the purge skips it and its Computer survives.
    expect(await restoreQuarantinedSpaces(prisma, b.id)).toBe(1);
    expect(await purgeQuarantinedOrganizations({ prisma, sandbox }, [orgB!])).toEqual([]);
    expect(await prisma.organization.count({ where: { id: orgB!.id } })).toBe(1);
    expect(
      await prisma.computer.count({ where: { spaceId: b.spaceId, providerRef: { not: null } } }),
    ).toBe(1);
  });

  it("retries stopping a Computer that was still running when its space was quarantined", async () => {
    const { id, spaceId } = await usedAccount("retry");
    await quarantineUserSpaces(prisma, id); // the earlier stop "failed": it is still running
    expect(await prisma.computer.count({ where: { spaceId, state: "running" } })).toBe(1);
    await retryQuarantinedStops({ prisma, sandbox });
    expect(await prisma.computer.count({ where: { spaceId, state: "running" } })).toBe(0);
  });
});
