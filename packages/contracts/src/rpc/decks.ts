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

export const DECK_EXPORT_FORMATS = ["pptx", "pdf"] as const;
export const DeckExportFormatSchema = z.enum(DECK_EXPORT_FORMATS);
export type DeckExportFormat = z.infer<typeof DeckExportFormatSchema>;

export const decksContract = {
  decks: {
    /** Exports a deck to editable PowerPoint or vector PDF in the person's Computer; the result
     * is a new artifact in the deck's chat. */
    export: oc
      .input(z.object({ artifactId: Id, format: DeckExportFormatSchema }))
      .output(ArtifactSchema),
  },
};
