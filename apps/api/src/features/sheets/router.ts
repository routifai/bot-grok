import { ORPCError } from "@orpc/server";
import { engineComputerClient } from "../../engine-client.js";
import type { RouterContext } from "../../routers/context.js";
import { engineEditTable, engineGetTable, engineGetTableRange } from "./service.js";

export function sheetsRouter(c: RouterContext) {
  const { authed, engineArtifactsDeps } = c;
  return {
    sheets: {
      table: authed.sheets.table.handler(async ({ context, input }) =>
        engineTableClient(context.actor, (engine) =>
          engineGetTable(engineArtifactsDeps, engine, context.actor, input.artifactId),
        ),
      ),
      editTable: authed.sheets.editTable.handler(async ({ context, input }) =>
        engineTableClient(context.actor, (engine) =>
          engineEditTable(engineArtifactsDeps, engine, context.actor, input),
        ),
      ),
      tableRange: authed.sheets.tableRange.handler(async ({ context, input }) =>
        engineTableClient(context.actor, (engine) =>
          engineGetTableRange(engineArtifactsDeps, engine, context.actor, input),
        ),
      ),
    },
  };
}

/** Tables live only on the engine: without one there is no sheet to read or edit. */
function engineTableClient<T>(
  actor: Parameters<typeof engineComputerClient>[0],
  run: (engine: NonNullable<ReturnType<typeof engineComputerClient>>) => Promise<T>,
): Promise<T> {
  const engine = engineComputerClient(actor);
  if (!engine) throw new ORPCError("NOT_FOUND", { message: "No workspace" });
  return run(engine);
}
