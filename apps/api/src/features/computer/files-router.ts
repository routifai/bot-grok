// `files.*`: the Computer workspace browser (list, preview, save to Library). It belongs to the
// `computer` capability and moves there with it; until then it is wired from `router.ts`.
import { ORPCError } from "@orpc/server";
import { engineComputerClient } from "../../engine-client.js";
import type { RouterContext } from "../../routers/context.js";
import {
  engineIngestAttachment,
  engineListFiles,
  engineReadFile,
  engineSaveFileToLibrary,
  engineUploadAttachment,
} from "./files.js";

export function filesRouter(c: RouterContext) {
  const { authed, engineFilesDeps } = c;
  return {
    files: {
      list: authed.files.list.handler(async ({ context, input }) => {
        const engine = engineComputerClient(context.actor);
        if (!engine) return { entries: [] };
        return engineListFiles(engineFilesDeps, engine, context.actor, input);
      }),
      read: authed.files.read.handler(async ({ context, input }) => {
        const engine = engineComputerClient(context.actor);
        if (!engine) throw new ORPCError("NOT_FOUND", { message: "No workspace" });
        return engineReadFile(engineFilesDeps, engine, context.actor, input);
      }),
      uploadAttachment: authed.files.uploadAttachment.handler(async ({ context, input }) => {
        const engine = engineComputerClient(context.actor);
        if (!engine) throw new ORPCError("NOT_FOUND", { message: "No workspace" });
        return engineUploadAttachment(engineFilesDeps, engine, context.actor, input);
      }),
      ingestAttachment: authed.files.ingestAttachment.handler(async ({ context, input }) => {
        const engine = engineComputerClient(context.actor);
        if (!engine) throw new ORPCError("NOT_FOUND", { message: "No workspace" });
        return engineIngestAttachment(engineFilesDeps, engine, context.actor, input);
      }),
      saveToLibrary: authed.files.saveToLibrary.handler(async ({ context, input }) => {
        const engine = engineComputerClient(context.actor);
        if (!engine) throw new ORPCError("NOT_FOUND", { message: "No workspace" });
        return engineSaveFileToLibrary(engineFilesDeps, engine, context.actor, input);
      }),
    },
  };
}
