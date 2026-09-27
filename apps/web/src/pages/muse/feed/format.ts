import { t } from "@lingui/core/macro";
import type { Post } from "@rakazo/contracts";

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** True when `iso` falls on the same calendar day as `now`. */
export function isToday(iso: string, now = new Date()): boolean {
  const date = new Date(iso);
  return !Number.isNaN(date.getTime()) && startOfDay(date) === startOfDay(now);
}

/**
 * The day a Post landed, not a timestamp: "Today", "Yesterday", a weekday for the last
 * week, else a short date (docs/muse/DESIGN.md, "Finished while you were away · Tue").
 */
export function formatRelativeDay(iso: string, locale: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (dayDiff <= 0) return t`Today`;
  if (dayDiff === 1) return t`Yesterday`;
  if (dayDiff < 7) return date.toLocaleDateString(locale || "en", { weekday: "short" });
  return date.toLocaleDateString(locale || "en", { month: "short", day: "numeric" });
}

/** Splits Posts into Today / Earlier, keeping each group's incoming order (newest first). */
export function groupPostsByRecency<T extends Pick<Post, "createdAt">>(
  posts: T[],
  now = new Date(),
): { today: T[]; earlier: T[] } {
  const today: T[] = [];
  const earlier: T[] = [];
  for (const post of posts) {
    (isToday(post.createdAt, now) ? today : earlier).push(post);
  }
  return { today, earlier };
}

/** The Followed-topic Post's source host ("example.com"), or null when it has none. */
export function sourceHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
