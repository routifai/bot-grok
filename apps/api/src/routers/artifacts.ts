import { AttachmentValidationError } from "@aiden/core";
import { IsolationError } from "@aiden/db";
import { ORPCError } from "@orpc/server";
import {
  ArtifactListCursorError,
  createOwnedArtifact,
  deleteArtifactFamily,
  getOwnedArtifact,
  getSpaceArtifact,
  getSpaceArtifactById,
  listArtifactVersions,
  listSpaceArtifacts,
} from "../artifacts.js";
import {
  engineGetArtifact,
  engineListArtifacts,
  engineListArtifactVersions,
  engineListSpaceArtifacts,
  engineRemoveArtifact,
} from "../engine-artifacts.js";
import { engineComputerClient } from "../engine-computer.js";
import { engineListFiles, engineReadFile, engineSaveFileToLibrary } from "../engine-files.js";

import type { RouterContext } from "./context.js";

export function artifactsRouter(c: RouterContext) {
  const { authed, repos, groupRepos, engineArtifactsDeps, engineFilesDeps, deps } = c;
  return {
    files: {
      list: authed.files.list.handler(async ({ context, input }) => {
        const engine = engineComputerClient();
        if (!engine) return { entries: [] };
        return engineListFiles(engineFilesDeps, engine, context.actor, input);
      }),
      read: authed.files.read.handler(async ({ context, input }) => {
        const engine = engineComputerClient();
        if (!engine) throw new ORPCError("NOT_FOUND", { message: "No workspace" });
        return engineReadFile(engineFilesDeps, engine, context.actor, input);
      }),
      saveToLibrary: authed.files.saveToLibrary.handler(async ({ context, input }) => {
        const engine = engineComputerClient();
        if (!engine) throw new ORPCError("NOT_FOUND", { message: "No workspace" });
        return engineSaveFileToLibrary(engineFilesDeps, engine, context.actor, input);
      }),
    },
    artifacts: {
      list: authed.artifacts.list.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        const engine = engineComputerClient();
        if (engine)
          return engineListArtifacts(engineArtifactsDeps, engine, context.actor, input.botId);
        const rows = await deps.prisma.artifact.findMany({
          where: {
            botId: input.botId,
            groupId: null,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        return rows.map((row) => ({
          id: row.id,
          botId: row.botId,
          groupId: row.groupId,
          runId: row.runId,
          name: row.name,
          description: row.description,
          mimeType: row.mimeType,
          size: row.size,
          version: row.version,
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      listSpace: authed.artifacts.listSpace.handler(async ({ context, input }) => {
        if (input.botId) await repos.getBot(context.actor, input.botId);
        const engine = engineComputerClient();
        if (engine)
          return engineListSpaceArtifacts(engineArtifactsDeps, engine, context.actor, input);
        try {
          return await listSpaceArtifacts(deps, context.actor, input);
        } catch (error) {
          if (error instanceof ArtifactListCursorError) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        }
      }),
      listVersions: authed.artifacts.listVersions.handler(async ({ context, input }) => {
        const engine = engineComputerClient();
        if (engine) {
          return engineListArtifactVersions(
            engineArtifactsDeps,
            engine,
            context.actor,
            input.familyId,
          );
        }
        return listArtifactVersions(deps, context.actor, input);
      }),
      create: authed.artifacts.create.handler(async ({ context, input }) => {
        const botId = input.botId
          ? (await repos.getBot(context.actor, input.botId)).id
          : (await groupRepos.getGroupTarget(context.actor, input.groupId!)).members[0]?.bot.id;
        if (!botId) throw new IsolationError();
        try {
          return await createOwnedArtifact(deps, context.actor, { ...input, botId });
        } catch (error) {
          if (error instanceof AttachmentValidationError) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        }
      }),
      get: authed.artifacts.get.handler(async ({ context, input }) => {
        if (input.groupId) {
          const group = await groupRepos.getGroupTarget(context.actor, input.groupId);
          const contextBotId = group.members[0]?.bot.id;
          if (!contextBotId) throw new IsolationError();
          return getSpaceArtifact(deps, context.actor, {
            artifactId: input.artifactId,
            groupId: input.groupId,
            contextBotId,
          });
        }
        await repos.getBot(context.actor, input.botId!);
        try {
          return await getOwnedArtifact(deps, context.actor, {
            botId: input.botId!,
            artifactId: input.artifactId,
          });
        } catch (error) {
          if (error instanceof IsolationError) throw error;
          throw error;
        }
      }),
      getById: authed.artifacts.getById.handler(async ({ context, input }) => {
        const engine = engineComputerClient();
        if (engine)
          return engineGetArtifact(engineArtifactsDeps, engine, context.actor, input.artifactId);
        return getSpaceArtifactById(deps, context.actor, input);
      }),
      remove: authed.artifacts.remove.handler(async ({ context, input }) => {
        const engine = engineComputerClient();
        if (engine)
          return engineRemoveArtifact(engineArtifactsDeps, engine, context.actor, input.artifactId);
        return deleteArtifactFamily(deps, context.actor, { familyId: input.artifactId });
      }),
    },
  };
}
