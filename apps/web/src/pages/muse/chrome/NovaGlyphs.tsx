import type { SVGProps } from "react";

/** A rounded rectangle as a path, so glyphs can punch real holes with `fillRule="evenodd"`. */
function roundRect(x: number, y: number, w: number, h: number, r: number): string {
  return `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 -${r} ${r}h-${w - 2 * r}a${r} ${r} 0 0 1 -${r} -${r}v-${h - 2 * r}a${r} ${r} 0 0 1 ${r} -${r}z`;
}

/**
 * Nova's own filled glyphs (docs/muse/DESIGN.md "Sidebar"): solid, rounded shapes in the
 * spirit of a Mac sidebar, drawn for Nova on a 20px grid. Not Apple's SF Symbols (their
 * license does not allow this use). They paint with `currentColor`; cut-outs are real holes,
 * so a glyph reads on any surface (glass, a selected row, a colored tile).
 */
type GlyphProps = SVGProps<SVGSVGElement>;

function Glyph({ children, ...props }: GlyphProps) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" {...props}>
      {children}
    </svg>
  );
}

/** A rounded speech bubble with a small tail at the lower left. */
export function ConversationGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path
        fill="currentColor"
        d="M10 3c4.3 0 7.6 2.8 7.6 6.4S14.3 15.8 10 15.8c-.9 0-1.7-.1-2.5-.3-.8.8-2.1 1.5-3.6 1.7a.4.4 0 0 1-.4-.6c.5-.6.8-1.3.9-2-1.6-1.2-2.5-2.9-2.5-4.7C1.9 5.8 5.5 3 10 3z"
      />
    </Glyph>
  );
}

/** Two rings and a center: a target. */
export function GoalsGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="10" cy="10" r="4.2" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="10" cy="10" r="1.7" fill="currentColor" />
    </Glyph>
  );
}

/** A filled page with three text lines cut out. */
export function FeedGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d={[
          roundRect(3.2, 3, 13.6, 14, 3.4),
          roundRect(5.9, 6.45, 8.2, 1.5, 0.75),
          roundRect(5.9, 9.25, 8.2, 1.5, 0.75),
          roundRect(5.9, 12.05, 5.4, 1.5, 0.75),
        ].join("")}
      />
    </Glyph>
  );
}

/** A light bulb with its base. */
export function IdeasGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path
        fill="currentColor"
        d="M10 2.4a5.6 5.6 0 0 0-3.3 10.1c.5.4.7.8.7 1.4v.4h5.2v-.4c0-.6.2-1 .7-1.4A5.6 5.6 0 0 0 10 2.4z"
      />
      <rect x="7.5" y="15.3" width="5" height="2.4" rx="1.1" fill="currentColor" />
    </Glyph>
  );
}

/** Three books on a shelf, the last one leaning. */
export function LibraryGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="3" y="3.4" width="3.3" height="13.6" rx="1" fill="currentColor" />
      <rect x="7.4" y="5" width="3.3" height="12" rx="1" fill="currentColor" />
      <rect
        x="12.2"
        y="3.8"
        width="3.3"
        height="13"
        rx="1"
        transform="rotate(-15 13.85 10.3)"
        fill="currentColor"
      />
    </Glyph>
  );
}

/** A bell with its clapper. */
export function WaitingGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path
        fill="currentColor"
        d="M10 2.5c.6 0 1 .4 1 1v.5a5 5 0 0 1 4 4.9v3l1.3 1.6c.4.5 0 1.2-.6 1.2H4.3c-.6 0-1-.7-.6-1.2L5 11.9v-3A5 5 0 0 1 9 4v-.5c0-.6.4-1 1-1zM8.2 16h3.6a1.8 1.8 0 0 1-3.6 0z"
      />
    </Glyph>
  );
}

/** A stem with a branch curving off to the right: a fork. */
export function ForkGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path
        d="M6.2 3.2v13.6M6.2 10.4c0-3.4 2.5-4.9 5.8-4.9h2.4M12.4 3.2l2.4 2.3-2.4 2.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Glyph>
  );
}

/** A small gear. */
export function SettingsGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M8.6 2.3h2.8l.4 2a5.8 5.8 0 0 1 1.5.9l2-.6 1.4 2.4-1.6 1.4a5.9 5.9 0 0 1 0 1.8l1.6 1.4-1.4 2.4-2-.6a5.8 5.8 0 0 1-1.5.9l-.4 2H8.6l-.4-2a5.8 5.8 0 0 1-1.5-.9l-2 .6-1.4-2.4 1.6-1.4a5.9 5.9 0 0 1 0-1.8L3.3 7l1.4-2.4 2 .6a5.8 5.8 0 0 1 1.5-.9zM10 7.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z"
      />
    </Glyph>
  );
}

/** A sidebar panel with its left column filled: show or hide the sidebar. */
export function SidebarGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect
        x="2.6"
        y="3.6"
        width="14.8"
        height="12.8"
        rx="3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <rect x="4.6" y="5.6" width="3.6" height="8.8" rx="1.2" fill="currentColor" />
    </Glyph>
  );
}

/** A calendar page with a header band and a few day marks cut out. */
export function CalendarGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d={[
          roundRect(3, 3.6, 14, 13.6, 2.8),
          roundRect(3, 7.4, 14, 1.2, 0),
          roundRect(5.8, 10.6, 2.4, 1.8, 0.6),
          roundRect(11.8, 10.6, 2.4, 1.8, 0.6),
          roundRect(5.8, 13.4, 2.4, 1.8, 0.6),
        ].join("")}
      />
    </Glyph>
  );
}

/** A magnifier. */
export function SearchGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <circle cx="8.6" cy="8.6" r="4.9" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <path
        d="M12.3 12.3 16.3 16.3"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </Glyph>
  );
}

/** A four-point spark. */
export function SparkGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path
        fill="currentColor"
        d="M10 2.6c.4 3.6 1.8 5 5.4 5.4v.4c-3.6.4-5 1.8-5.4 5.4h-.4C9.2 10.2 7.8 8.8 4.2 8.4V8c3.6-.4 5-1.8 5.4-5.4z"
      />
      <path
        fill="currentColor"
        d="M15 12.4c.2 1.5.8 2.1 2.3 2.3v.3c-1.5.2-2.1.8-2.3 2.3h-.3c-.2-1.5-.8-2.1-2.3-2.3v-.3c1.5-.2 2.1-.8 2.3-2.3z"
      />
    </Glyph>
  );
}

/** A right-pointing chevron for grouped-list rows. */
export function ChevronGlyph(props: GlyphProps) {
  return (
    <svg viewBox="0 0 8 13" aria-hidden="true" focusable="false" {...props}>
      <path
        d="M1.5 1.5 6.5 6.5 1.5 11.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
