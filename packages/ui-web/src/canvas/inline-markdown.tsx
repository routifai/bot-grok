import type { ReactNode } from "react";

/**
 * Canvas `text` nodes allow inline markdown only (bold, italic, code, links) — never
 * headings, lists, or tables, which have their own catalog nodes. A tiny regex tokenizer
 * keeps this self-contained instead of pulling in chat-ui's full GFM pipeline, which would
 * also create a package cycle (chat-ui already depends on ui-web).
 */
const TOKEN_RE = /\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g;

export function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null = TOKEN_RE.exec(text);
  let key = 0;
  while (match !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const [, bold, italic, code, linkText, linkHref] = match;
    if (bold !== undefined) nodes.push(<strong key={key++}>{bold}</strong>);
    else if (italic !== undefined) nodes.push(<em key={key++}>{italic}</em>);
    else if (code !== undefined)
      nodes.push(
        <code key={key++} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.92em]">
          {code}
        </code>,
      );
    else if (linkText !== undefined && linkHref !== undefined) {
      nodes.push(
        <a
          key={key++}
          href={linkHref}
          target="_blank"
          rel="noreferrer noopener"
          className="text-link underline underline-offset-2"
        >
          {linkText}
        </a>,
      );
    }
    lastIndex = TOKEN_RE.lastIndex;
    match = TOKEN_RE.exec(text);
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}
