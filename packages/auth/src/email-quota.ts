import type { PrismaClient } from "@nova/db";

/** Fixed-window counters keyed by string; `consume` is true while under the cap. */
export interface EmailQuota {
  consume(key: string, windowMs: number, max: number): Promise<boolean>;
}

/**
 * Database-backed so every API process shares one count. A single atomic upsert starts a new
 * window when the old one has lapsed and otherwise increments.
 */
export function prismaEmailQuota(prisma: Pick<PrismaClient, "$queryRaw">): EmailQuota {
  return {
    async consume(key, windowMs, max) {
      const now = Date.now();
      const rows = await prisma.$queryRaw<Array<{ count: number }>>`
        INSERT INTO rate_limit (id, key, count, "lastRequest")
        VALUES (${key}, ${key}, 1, ${now})
        ON CONFLICT (key) DO UPDATE SET
          count = CASE WHEN rate_limit."lastRequest" < ${now - windowMs} THEN 1 ELSE rate_limit.count + 1 END,
          "lastRequest" = CASE WHEN rate_limit."lastRequest" < ${now - windowMs} THEN ${now} ELSE rate_limit."lastRequest" END
        RETURNING count`;
      return Number(rows[0]?.count ?? 1) <= max;
    },
  };
}

/** In-memory counters for tests and single-process tools. */
export function memoryEmailQuota(): EmailQuota {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    async consume(key, windowMs, max) {
      const now = Date.now();
      const current = windows.get(key);
      const next =
        current && now - current.start < windowMs
          ? { start: current.start, count: current.count + 1 }
          : { start: now, count: 1 };
      windows.set(key, next);
      return next.count <= max;
    },
  };
}
