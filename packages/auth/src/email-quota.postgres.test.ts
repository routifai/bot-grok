import { createDb } from "@nova/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prismaEmailQuota } from "./email-quota.js";
import { createAuth } from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe : describe.skip;

describePostgres("per-address caps survive Better Auth's rate-limit cleanup (PostgreSQL)", () => {
  const { prisma, pool } = createDb(databaseUrl ?? "postgres://unused");
  const key = `test:${Date.now()}`;

  beforeAll(async () => {
    await prisma.$executeRaw`DELETE FROM email_quota WHERE key LIKE 'test:%'`;
  });
  afterAll(async () => {
    vi.useRealTimers();
    await prisma.$executeRaw`DELETE FROM email_quota WHERE key LIKE 'test:%'`;
    await prisma.$disconnect();
    await pool?.end();
  });

  it("keeps counting across a window rollover that empties rate_limit", async () => {
    const quota = prismaEmailQuota(prisma);
    const auth = createAuth(prisma, {
      secret: "offline-auth-secret-at-least-32-characters",
      baseURL: "http://auth.example.test",
      webOrigin: "http://web.example.test",
      rateLimit: true,
      emailQuota: quota,
    });
    const hit = () =>
      auth.handler(
        new Request("http://auth.example.test/api/auth/get-session", {
          headers: { origin: "http://web.example.test", "x-forwarded-for": "203.0.113.5" },
        }),
      );
    const hour = 60 * 60 * 1000;
    expect(await quota.consume(key, hour, 5)).toBe(true);
    expect(await quota.consume(key, hour, 5)).toBe(true);
    await hit();
    const before = await prisma.$queryRaw<
      Array<{ n: bigint }>
    >`SELECT count(*) AS n FROM rate_limit`;
    expect(Number(before[0]!.n)).toBeGreaterThan(0);

    // Better Auth prunes its own rows once they are older than its longest window.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3 * 60 * 1000);
    await hit();
    await hit();
    const after = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM rate_limit WHERE "lastRequest" < ${Date.now() - 2 * 60 * 1000}`;
    expect(Number(after[0]!.n)).toBe(0);

    // The caps are untouched: the third and fourth use still count, and the sixth is refused.
    expect(await quota.consume(key, hour, 5)).toBe(true);
    expect(await quota.consume(key, hour, 5)).toBe(true);
    expect(await quota.consume(key, hour, 5)).toBe(true);
    expect(await quota.consume(key, hour, 5)).toBe(false);
  });

  it("blocks only after enough failures, and a window that lapses starts fresh", async () => {
    const quota = prismaEmailQuota(prisma);
    const failKey = `${key}:fail`;
    const window = 15 * 60 * 1000;
    vi.useRealTimers();
    for (let attempt = 0; attempt < 3; attempt += 1) await quota.fail(failKey, window);
    expect(await quota.blocked(failKey, window, 3)).toBe(true);
    expect(await quota.blocked(failKey, window, 4)).toBe(false);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + window + 1000);
    expect(await quota.blocked(failKey, window, 3)).toBe(false);
    await quota.fail(failKey, window);
    expect(await quota.blocked(failKey, window, 2)).toBe(false);
  });
});
