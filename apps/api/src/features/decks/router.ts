import { ORPCError } from "@orpc/server";
import { engineComputerClient } from "../../engine-client.js";
import type { RouterContext } from "../../routers/context.js";
import { engineExportDeck } from "./service.js";

export function decksRouter(c: RouterContext) {
  const { authed, engineArtifactsDeps } = c;
  return {
    decks: {
      export: authed.decks.export.handler(async ({ context, input }) => {
        // Decks live only on the engine: without one there is no Computer to render in.
        const engine = engineComputerClient(context.actor);
        if (!engine) throw new ORPCError("NOT_FOUND", { message: "No workspace" });
        return engineExportDeck(engineArtifactsDeps, engine, context.actor, input);
      }),
    },
  };
}
