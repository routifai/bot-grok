import { ORPCError } from "@orpc/server";
import { engineComputerClient } from "../../engine-client.js";
import type { RouterContext } from "../../routers/context.js";
import { engineGetPublication, enginePublishArtifact, engineUnpublishArtifact } from "./service.js";

function requireEngine(actor: Parameters<typeof engineComputerClient>[0]) {
  const engine = engineComputerClient(actor);
  if (!engine) throw new ORPCError("NOT_FOUND", { message: "Apps are not available" });
  return engine;
}

export function appsRouter(c: RouterContext) {
  const { authed, engineArtifactsDeps } = c;
  return {
    apps: {
      publish: authed.apps.publish.handler(async ({ context, input }) => {
        const engine = requireEngine(context.actor);
        return enginePublishArtifact(engineArtifactsDeps, engine, context.actor, input);
      }),
      unpublish: authed.apps.unpublish.handler(async ({ context, input }) => {
        const engine = requireEngine(context.actor);
        return engineUnpublishArtifact(
          engineArtifactsDeps,
          engine,
          context.actor,
          input.artifactId,
        );
      }),
      publishState: authed.apps.publishState.handler(async ({ context, input }) => {
        const engine = engineComputerClient(context.actor);
        if (!engine) return null;
        return engineGetPublication(engineArtifactsDeps, engine, context.actor, input.artifactId);
      }),
    },
  };
}
