import type { PrismaClient } from "@nova/db";

/**
 * Fixed-window counters keyed by string, for per-address caps. Kept apart from Better Auth's own
 * rate-limit table, which that library prunes by age (about a minute), so hourly and daily
 * windows would not survive there.
 */
export interface EmailQuota {
  /** Count one use; true while the window's count is within `max`. */
  consume(key: string, windowMs: number, max: number): Promise<boolean>;
  /** Count one failure in the window. */
  fail(key: string, windowMs: number): Promise<void>;
  /** True once the window's count has reached `max`. */
  blocked(key: string, windowMs: number, max: number): Promise<boolean>;
}

/**
 * Database-backed so every API process shares one count. A single atomic upsert starts a new
 * window when the old one has lapsed and otherwise increments.
 */
export function prismaEmailQuota(prisma: Pick<PrismaClient, "$queryRaw">): EmailQuota {
  const bump = async (key: string, windowMs: number) => {
    const now = Date.now();
    const rows = await prisma.$queryRaw<Array<{ count: number }>>`
      INSERT INTO email_quota (key, count, "windowStart")
      VALUES (${key}, 1, ${now})
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN email_quota."windowStart" < ${now - windowMs} THEN 1 ELSE email_quota.count + 1 END,
        "windowStart" = CASE WHEN email_quota."windowStart" < ${now - windowMs} THEN ${now} ELSE email_quota."windowStart" END
      RETURNING count`;
    return Number(rows[0]?.count ?? 1);
  };
  return {
    async consume(key, windowMs, max) {
      return (await bump(key, windowMs)) <= max;
    },
    async fail(key, windowMs) {
      await bump(key, windowMs);
    },
    async blocked(key, windowMs, max) {
      const rows = await prisma.$queryRaw<Array<{ count: number }>>`
        SELECT count FROM email_quota WHERE key = ${key} AND "windowStart" >= ${Date.now() - windowMs}`;
      return Number(rows[0]?.count ?? 0) >= max;
    },
  };
}

/** In-memory counters for tests and single-process tools. */
export function memoryEmailQuota(): EmailQuota {
  const windows = new Map<string, { start: number; count: number }>();
  const bump = (key: string, windowMs: number) => {
    const now = Date.now();
    const current = windows.get(key);
    const next =
      current && now - current.start < windowMs
        ? { start: current.start, count: current.count + 1 }
        : { start: now, count: 1 };
    windows.set(key, next);
    return next.count;
  };
  return {
    async consume(key, windowMs, max) {
      return bump(key, windowMs) <= max;
    },
    async fail(key, windowMs) {
      bump(key, windowMs);
    },
    async blocked(key, windowMs, max) {
      const current = windows.get(key);
      return Boolean(current && Date.now() - current.start < windowMs && current.count >= max);
    },
  };
}
