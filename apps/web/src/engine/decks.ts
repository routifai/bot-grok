import { ORPCError } from "@orpc/server";
import {
  editOmnigentDeck,
  exportOmnigentDeck,
  getOmnigentDeckTheme,
  getOmnigentDeckThemeSample,
  listOmnigentDeckThemes,
  OmnigentApiError,
  OmnigentDeckConflictError,
} from "@superchat/adapters/omnigent/browser";
import { artifactNotFound, toArtifact } from "./artifact-shape";
import { engineClient, NO_EMAIL } from "./client";
import { os } from "./context";

/** `decks.*`: a `.deck.html` themed, hand-edited as source patches and exported to PowerPoint or
 * PDF in the person's Computer. */
export const decksRouter = {
  decks: {
    theme: os.decks.theme.handler(async ({ input }) => {
      try {
        return {
          theme: await getOmnigentDeckTheme(engineClient(), NO_EMAIL, input.artifactId),
        };
      } catch (error) {
        return artifactNotFound(error);
      }
    }),
    themes: os.decks.themes.handler(async () => {
      try {
        const found = await listOmnigentDeckThemes(engineClient(), NO_EMAIL);
        return {
          defaultTheme: found.default,
          themes: found.themes.map(({ best_for: bestFor, ...theme }) => ({ ...theme, bestFor })),
        };
      } catch (error) {
        return artifactNotFound(error);
      }
    }),
    sample: os.decks.sample.handler(async ({ input }) => {
      try {
        return { html: await getOmnigentDeckThemeSample(engineClient(), NO_EMAIL, input.themeId) };
      } catch (error) {
        return artifactNotFound(error);
      }
    }),
    // A stale base and a patch the engine will not apply exactly are both CONFLICT; the message
    // tells the web which (it reloads, or says "ask Superchat instead").
    edit: os.decks.edit.handler(async ({ input }) => {
      try {
        const created = await editOmnigentDeck(
          engineClient(),
          NO_EMAIL,
          input.artifactId,
          input.baseVersion,
          input.patches,
        );
        return toArtifact(created, null);
      } catch (error) {
        if (error instanceof OmnigentDeckConflictError) {
          throw new ORPCError("CONFLICT", { message: error.message });
        }
        if (error instanceof OmnigentApiError && error.code === "invalid_input") {
          throw new ORPCError("BAD_REQUEST", {
            message: error.detail ?? "That edit isn't allowed.",
          });
        }
        return artifactNotFound(error);
      }
    }),
    export: os.decks.export.handler(async ({ input }) => {
      try {
        const created = await exportOmnigentDeck(
          engineClient(),
          NO_EMAIL,
          input.artifactId,
          input.format,
        );
        return toArtifact(created, null);
      } catch (error) {
        if (error instanceof OmnigentApiError) {
          if (error.code === "runner_unavailable") {
            throw new ORPCError("SERVICE_UNAVAILABLE", {
              message: "Your Computer is still starting. Try again in a moment.",
            });
          }
          if (error.code === "invalid_input") {
            throw new ORPCError("BAD_REQUEST", {
              message: error.detail ?? "That deck couldn't be exported.",
            });
          }
        }
        return artifactNotFound(error);
      }
    }),
  },
};
