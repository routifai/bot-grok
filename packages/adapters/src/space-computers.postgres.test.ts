import {
  bootstrapUserSpace,
  createDb,
  quarantineUserSpaces,
  restoreQuarantinedSpaces,
} from "@nova/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import {
  identityMaintenance,
  purgeQuarantinedOrganizations,
  resetIdentityMaintenance,
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
});
