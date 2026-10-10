import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";
import { ArtifactSchema } from "./artifacts.js";

/** A deck is an HTML artifact whose file name ends with this (the engine uses the same marker). */
export const DECK_NAME_SUFFIX = ".deck.html";

/** True when an artifact file name marks a deck (`*.deck.html`, any case). */
export function isDeckArtifactName(name: string): boolean {
  return name.length > DECK_NAME_SUFFIX.length && name.toLowerCase().endsWith(DECK_NAME_SUFFIX);
}

/** How many slides a deck's HTML holds (its `<section class="slide …">` elements). */
export function deckSlideCount(html: string): number {
  return html.match(/<section\b[^>]*\bclass="[^"]*\bslide\b/g)?.length ?? 0;
}

export const DECK_EXPORT_FORMATS = ["pptx", "pdf"] as const;
export const DeckExportFormatSchema = z.enum(DECK_EXPORT_FORMATS);
export type DeckExportFormat = z.infer<typeof DeckExportFormatSchema>;

const ElementId = z.string().min(1).max(128);

/** One source patch of a deck, applied by the engine on `data-nova-id` (same shape on the wire). */
export const DeckPatchSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set-text"), id: ElementId, text: z.string().max(20_000) }),
  z.object({
    kind: z.literal("set-style"),
    id: ElementId,
    /** Kebab-case CSS property -> value; null removes the declaration. */
    style: z.record(z.string().regex(/^[a-z-]{1,64}$/), z.string().max(512).nullable()),
    /** What the editor showed before, only to word "you changed X" (never written to the file). */
    before: z.record(z.string().regex(/^[a-z-]{1,64}$/), z.string().max(200)).optional(),
  }),
  z.object({
    kind: z.literal("set-attributes"),
    id: ElementId,
    attributes: z.object({
      href: z.string().max(2048).nullable().optional(),
      alt: z.string().max(1024).nullable().optional(),
    }),
  }),
  z.object({ kind: z.literal("remove-element"), id: ElementId }),
  z.object({ kind: z.literal("duplicate-element"), id: ElementId }),
  /** Swap the whole theme (tokens, theme CSS, fonts); the slides are untouched. */
  z.object({ kind: z.literal("set-theme"), theme: z.string().min(1).max(60) }),
  z.object({ kind: z.literal("set-full-source"), source: z.string().min(1).max(25_000_000) }),
]);
export type DeckPatch = z.infer<typeof DeckPatchSchema>;

export const DECK_THEME_CATEGORIES = ["professional", "editorial", "bold", "dark"] as const;

/** One entry of the deck theme dictionary; `preview` is a small thumbnail as a `data:` URI. */
export const DeckThemeSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Two to four words, shown under a picker tile's thumbnail. */
  tagline: z.string(),
  mood: z.string(),
  category: z.enum(DECK_THEME_CATEGORIES),
  mode: z.enum(["light", "dark"]),
  bestFor: z.string(),
  preview: z.string(),
});
export type DeckTheme = z.infer<typeof DeckThemeSchema>;

export const decksContract = {
  decks: {
    /** The id of the theme a deck is on, or null for a hand-made deck (the picker's check mark). */
    theme: oc
      .input(z.object({ artifactId: Id }))
      .output(z.object({ theme: z.string().nullable() })),
    /** The theme dictionary behind the deck panel's Theme picker. */
    themes: oc
      .input(z.object({}))
      .output(z.object({ themes: z.array(DeckThemeSchema), defaultTheme: z.string() })),
    /** The kit's sample deck (cover, agenda, figures, chart, table, quote, close) built in one
     * theme: a complete `.deck.html` for the theme preview. */
    sample: oc
      .input(z.object({ themeId: z.string().min(1).max(60) }))
      .output(z.object({ html: z.string() })),
    /** Hand edits as source patches: a new `manual` version; CONFLICT when `baseVersion` is no
     * longer the newest or the engine cannot apply a patch exactly (ask Nova instead). */
    edit: oc
      .input(
        z.object({
          artifactId: Id,
          baseVersion: z.number().int().min(1),
          patches: z.array(DeckPatchSchema).min(1).max(200),
        }),
      )
      .output(ArtifactSchema),
    /** Exports a deck to editable PowerPoint or vector PDF in the person's Computer; the result
     * is a new artifact in the deck's chat. */
    export: oc
      .input(z.object({ artifactId: Id, format: DeckExportFormatSchema }))
      .output(ArtifactSchema),
  },
};
