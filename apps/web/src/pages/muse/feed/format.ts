import type { Post } from "@nova/contracts";
import { markdownToPlainText } from "../../../lib/markdown-plain-text";

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

const CAVEAT_OPENING =
  /^[\s*_>]*(the findings\b|most of this\b|i did not\b|i didn't\b|note\s*:|caveat\b)/i;

/** Drops leading paragraphs that hedge about sources instead of reporting (older cards
 * opened that way), keeping at least one paragraph of content. */
function withoutLeadingCaveats(body: string): string {
  const blocks = body.split(/\n\s*\n/);
  const kept: string[] = [];
  let reading = false;
  for (const [index, block] of blocks.entries()) {
    const isHeading = /^\s{0,3}#{1,6}\s/.test(block);
    const hasMore = blocks
      .slice(index + 1)
      .some((rest) => rest.trim() && !CAVEAT_OPENING.test(rest));
    if (!reading && !isHeading && CAVEAT_OPENING.test(block) && hasMore) continue;
    if (!isHeading && block.trim()) reading = true;
    kept.push(block);
  }
  return kept.join("\n\n");
}

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

  const { heading, text } = markdownToPlainText(withoutLeadingCaveats(body));
  return { heading, text, sources: sources.slice(0, 3) };
}
