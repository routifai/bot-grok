import { ORPCError } from "@orpc/server";
import { engineComputerClient } from "../../engine-client.js";
import type { RouterContext } from "../../routers/context.js";
import { engineChartThumbnail } from "./service.js";

export function chartsRouter(c: RouterContext) {
  const { authed, engineArtifactsDeps } = c;
  return {
    charts: {
      thumbnail: authed.charts.thumbnail.handler(async ({ context, input }) => {
        // Charts live only on the engine: without one there is no chart to draw.
        const engine = engineComputerClient(context.actor);
        if (!engine) throw new ORPCError("NOT_FOUND", { message: "No workspace" });
        return engineChartThumbnail(engineArtifactsDeps, engine, context.actor, input);
      }),
    },
  };
}
