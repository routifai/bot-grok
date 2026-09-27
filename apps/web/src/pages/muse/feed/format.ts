import type { Post } from "@aiden/contracts";

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** True when `iso` falls on the same calendar day as `now`. */
export function isToday(iso: string, now = new Date()): boolean {
  const date = new Date(iso);
  return !Number.isNaN(date.getTime()) && startOfDay(date) === startOfDay(now);
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
