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

const MARKDOWN_LINK = /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL = /https?:\/\/[^\s)\]>]+/g;

/** A source link taken from a Post body: its URL and the host shown for it. */
export type PostSource = { url: string; host: string };

/** A topic finding's markdown body, reduced to what a card shows: its first heading (if
 * any), a plain-text preview with markdown syntax removed, and up to three source links. */
export function postPreview(
  body: string,
  sourceUrl: string | null = null,
): { heading: string | null; text: string; sources: PostSource[] } {
  const urls = [...(sourceUrl ? [sourceUrl] : [])];
  for (const match of body.matchAll(MARKDOWN_LINK)) urls.push(match[2] ?? "");
  for (const match of body.matchAll(BARE_URL)) urls.push(match[0].replace(/[.,;:]+$/, ""));
  const sources: PostSource[] = [];
  for (const url of urls) {
    const host = sourceHost(url);
    if (host && !sources.some((source) => source.host === host)) sources.push({ url, host });
  }

  const inline = (line: string) =>
    line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(MARKDOWN_LINK, "$1")
      .replace(BARE_URL, "")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/(\*\*|__|\*|_|~~)(.+?)\1/g, "$2")
      .replace(/\s+/g, " ")
      .trim();

  let heading: string | null = null;
  const lines: string[] = [];
  for (const raw of body.split("\n")) {
    const headingMatch = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(raw);
    if (headingMatch) {
      const text = inline(headingMatch[1] ?? "");
      if (heading === null && lines.length === 0) heading = text || null;
      else if (text) lines.push(text);
      continue;
    }
    const text = inline(
      raw
        .replace(/^\s*(```|~~~).*$/, "")
        .replace(/^\s*>+\s?/, "")
        .replace(/^\s*([-*+]|\d+[.)])\s+/, "")
        .replace(/^\s*([-*_]\s*){3,}$/, ""),
    );
    if (text) lines.push(text);
  }
  return { heading, text: lines.join(" "), sources: sources.slice(0, 3) };
}
