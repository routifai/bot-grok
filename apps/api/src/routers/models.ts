import {
  buildModelConnectPlaintext,
  createVoiceProvider,
  defaultCatalogModelId,
  listAvailablePiCatalog,
  listPiCatalog,
  modelCredentialAuthKindsForSpace,
  modelCredentialDto,
  probeOpenAiCompatibleModels,
  readStoredModelAuth,
  scriptedCatalogEntry,
  selectDefaultCredentialId,
  serializeModelSecret,
  UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE,
  validateModelAuthAvailability,
} from "@aiden/adapters";
import type { Actor } from "@aiden/contracts";
import { OPENAI_COMPATIBLE_PROVIDER_ID, usableModelId } from "@aiden/contracts";
import {
  defaultModelCredentialCandidates,
  deleteUnreferencedCredentialSecret,
  findDefaultVoiceCredential,
  findModelCredential,
  newestModelCredentialOrder,
  newestVoiceCredentialOrder,
  Prisma,
  selectSpaceModelPreference,
  selectSpaceVoicePreference,
} from "@aiden/db";
import { ORPCError } from "@orpc/server";
import { withSerializableRetry } from "../serializable-retry.js";
import {
  disconnectVoiceCredential,
  listVoiceCatalog,
  loadDefaultVoiceCredential,
  loadVoiceCredential,
  persistVoiceCredential,
  prepareVoice,
  toVoiceCredential,
  toVoiceStatus,
  voiceContext,
} from "../voice.js";
import type { RouterContext, RouterDeps } from "./context.js";

async function persistModelCredential(
  deps: RouterDeps,
  actor: Actor,
  input: {
    provider: string;
    plaintext: string;
    label?: string;
    modelId?: string;
    supportsImages?: boolean;
    signal?: AbortSignal;
  },
) {
  throwIfAborted(input.signal);
  const requestedModelId = usableModelId(input.modelId);
  const authError = requestedModelId
    ? validateModelAuthAvailability(input.provider, requestedModelId, input.plaintext)
    : undefined;
  if (authError) throw new ORPCError("BAD_REQUEST", { message: authError });
  const stored = await deps.secrets.put(input.plaintext, {
    operationId: "cred",
    traceId: "cred",
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: input.signal ?? new AbortController().signal,
  });
  throwIfAborted(input.signal);
  const cred = await withSerializableRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        throwIfAborted(input.signal);
        const existing = await tx.userModelCredential.findFirst({
          where: { userId: actor.userId, provider: input.provider },
          orderBy: newestModelCredentialOrder,
        });
        throwIfAborted(input.signal);
        const secret = await tx.secret.create({
          data: {
            id: stored.id,
            userId: actor.userId,
            spaceId: null,
            kind: "model",
            ciphertext: stored.ciphertext,
          },
        });
        throwIfAborted(input.signal);
        const credential = !existing
          ? await tx.userModelCredential.create({
              data: {
                userId: actor.userId,
                provider: input.provider,
                label: input.label ?? input.provider,
                secretId: secret.id,
                supportsImages: input.supportsImages ?? false,
              },
            })
          : await tx.userModelCredential.update({
              where: { id: existing.id },
              data: {
                label: input.label ?? input.provider,
                secretId: secret.id,
                ...(input.supportsImages !== undefined
                  ? { supportsImages: input.supportsImages }
                  : {}),
              },
            });
        throwIfAborted(input.signal);
        const defaultModel =
          requestedModelId ??
          defaultCatalogModelId(input.provider, input.plaintext) ??
          usableModelId(deps.env.defaultModel);
        await selectSpaceModelPreference(tx, actor, credential.id, defaultModel);
        throwIfAborted(input.signal);
        if (existing) {
          await deleteUnreferencedCredentialSecret(tx, {
            credentialKind: "model",
            credentialId: existing.id,
            secretId: existing.secretId,
          });
          throwIfAborted(input.signal);
        }
        return { ...credential, isDefault: true, defaultModel };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  return modelCredentialDto(cred, input.plaintext);
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new Error("Request cancelled");
}

export function modelsRouter(c: RouterContext) {
  const { authed, deps } = c;
  return {
    models: {
      list: authed.models.list.handler(async ({ context }) => {
        const auth = await modelCredentialAuthKindsForSpace(
          deps.prisma,
          deps.secrets,
          context.actor,
        );
        return [...listAvailablePiCatalog(auth.byProvider, auth.byModel), scriptedCatalogEntry];
      }),
      credentials: authed.models.credentials.handler(async ({ context }) => {
        const rows = await deps.prisma.userModelCredential.findMany({
          where: { userId: context.actor.userId },
          include: {
            preferences: {
              where: { userId: context.actor.userId, spaceId: context.actor.spaceId },
            },
          },
          orderBy: newestModelCredentialOrder,
        });
        const secrets = rows.length
          ? await deps.prisma.secret.findMany({
              where: {
                id: { in: rows.map((row) => row.secretId) },
                userId: context.actor.userId,
                spaceId: null,
              },
              select: { id: true, ciphertext: true },
            })
          : [];
        const ciphertextById = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
        return rows.map((row) => {
          const preference = row.preferences[0];
          const selected = {
            ...row,
            isDefault: preference?.isDefault ?? false,
            defaultModel: preference?.modelId ?? null,
          };
          const ciphertext = ciphertextById.get(row.secretId);
          if (!ciphertext) return modelCredentialDto(selected);
          try {
            return modelCredentialDto(selected, deps.secrets.load(ciphertext, row.secretId));
          } catch {
            return modelCredentialDto(selected);
          }
        });
      }),
      connect: authed.models.connect.handler(async ({ context, input }) => {
        let plaintext: string;
        try {
          let previousPlaintext: string | undefined;
          let omitVisionModelIds = false;
          const credential = await findModelCredential(deps.prisma, context.actor, input.provider);
          if (credential) {
            const secret = await deps.prisma.secret.findFirst({
              where: { id: credential.secretId, userId: context.actor.userId, spaceId: null },
              select: { ciphertext: true },
            });
            if (secret) {
              try {
                previousPlaintext = deps.secrets.load(secret.ciphertext, credential.secretId);
              } catch (error) {
                // Explicit key replacement must still succeed when the prior
                // ciphertext is unreadable. For OpenAI-compatible connections,
                // omit visionModelIds so a partial one-model list does not wipe
                // other enabled models; DB supportsImages + defaultModel remain
                // the legacy fallback.
                if (input.apiKey === undefined) throw error;
                if (input.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
                  omitVisionModelIds = true;
                }
              }
            }
          }
          plaintext = buildModelConnectPlaintext(input, previousPlaintext, {
            omitVisionModelIds,
          });
        } catch (error) {
          throw new ORPCError("BAD_REQUEST", {
            message: error instanceof Error ? error.message : "Invalid model connection",
          });
        }
        return persistModelCredential(deps, context.actor, {
          provider: input.provider,
          plaintext,
          label: input.label,
          modelId: input.modelId,
          supportsImages: input.supportsImages,
          signal: context.signal,
        });
      }),
      probeOpenAiCompatible: authed.models.probeOpenAiCompatible.handler(
        async ({ context, input }) => {
          try {
            const models = await probeOpenAiCompatibleModels(input, undefined, context.signal);
            return { models };
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", {
              message: error instanceof Error ? error.message : "Could not list models",
            });
          }
        },
      ),
      beginOAuth: authed.models.beginOAuth.handler(async ({ context, input }) => {
        return deps.oauthLogins.begin({
          userId: context.actor.userId,
          spaceId: context.actor.spaceId,
          provider: input.provider,
          modelId: input.modelId,
          label: input.label,
          signal: context.signal,
        });
      }),
      submitOAuthCode: authed.models.submitOAuthCode.handler(async ({ context, input }) => {
        return deps.oauthLogins.submit(input.loginId, context.actor, input.code);
      }),
      completeOAuth: authed.models.completeOAuth.handler(async ({ context, input }) => {
        const result = await deps.oauthLogins.complete(input.loginId, {
          userId: context.actor.userId,
          spaceId: context.actor.spaceId,
        });
        return result.status === "connected" ? { status: "ready" as const } : result;
      }),
      finishOAuth: authed.models.finishOAuth.handler(async ({ context, input }) => {
        throwIfAborted(context.signal);
        const result = await deps.oauthLogins.finish(
          input.loginId,
          context.actor,
          async (login) => {
            return persistModelCredential(deps, context.actor, {
              provider: login.provider,
              plaintext: serializeModelSecret({ kind: "oauth", credential: login.credential }),
              label:
                login.label ??
                listPiCatalog().find((entry) => entry.provider === login.provider)?.providerName,
              modelId: login.modelId,
              signal: login.signal,
            });
          },
        );
        if (result.status === "pending") {
          throw new ORPCError("CONFLICT", { message: "Sign-in has not finished yet." });
        }
        if (result.status === "error") {
          throw new ORPCError("NOT_FOUND", { message: result.error });
        }
        return result.value;
      }),
      cancelOAuth: authed.models.cancelOAuth.handler(async ({ context, input }) => {
        await deps.oauthLogins.cancel(input.loginId, context.actor);
        return { ok: true as const };
      }),
      setDefault: authed.models.setDefault.handler(async ({ context, input }) => {
        await withSerializableRetry(() =>
          deps.prisma.$transaction(
            async (tx) => {
              const [preferences, credentials] = await Promise.all([
                tx.spaceModelPreference.findMany({
                  where: {
                    spaceId: context.actor.spaceId,
                    userId: context.actor.userId,
                    credential: { provider: input.provider },
                  },
                  include: { credential: true },
                }),
                tx.userModelCredential.findMany({
                  where: { userId: context.actor.userId, provider: input.provider },
                }),
              ]);
              const candidates = defaultModelCredentialCandidates({
                provider: input.provider,
                modelId: input.modelId,
                preferences,
                credentials,
              });
              if (candidates.length === 0) {
                throw new ORPCError("NOT_FOUND", {
                  message: `No model credential is connected for ${input.provider}.`,
                });
              }
              const savedModelId = new Map(
                preferences.map((preference) => [preference.credential.id, preference.modelId]),
              );
              const readyIds: string[] = [];
              let authFailure: string | undefined;
              let sawReadable = false;
              for (const candidate of candidates) {
                const auth = await readStoredModelAuth(
                  tx,
                  deps.secrets,
                  context.actor.userId,
                  candidate.secretId,
                  input.provider,
                  input.modelId,
                );
                if (auth.status === "unreadable") continue;
                sawReadable = true;
                if (auth.status === "rejected") {
                  authFailure ??= auth.message;
                  continue;
                }
                readyIds.push(candidate.id);
              }
              const chosenId = selectDefaultCredentialId({
                provider: input.provider,
                modelId: input.modelId,
                orderedIds: candidates.map((candidate) => candidate.id),
                readyIds,
                savedModelId: (credentialId) => savedModelId.get(credentialId),
              });
              const fallbackId = !sawReadable ? candidates[0]?.id : undefined;
              const credentialId = chosenId ?? fallbackId;
              if (!credentialId) {
                throw new ORPCError("BAD_REQUEST", {
                  message: authFailure ?? UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE,
                });
              }
              await selectSpaceModelPreference(tx, context.actor, credentialId, input.modelId);
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
        );
        return { ok: true as const };
      }),
    },
    voice: {
      catalog: authed.voice.catalog.handler(async () => listVoiceCatalog()),
      status: authed.voice.status.handler(async ({ context }) => {
        const cred = await findDefaultVoiceCredential(deps.prisma, context.actor);
        return toVoiceStatus(cred);
      }),
      credentials: authed.voice.credentials.handler(async ({ context }) => {
        const rows = await deps.prisma.userVoiceCredential.findMany({
          where: { userId: context.actor.userId },
          include: {
            preferences: {
              where: { userId: context.actor.userId, spaceId: context.actor.spaceId },
            },
          },
          orderBy: newestVoiceCredentialOrder,
        });
        return rows.map((row) => {
          const preference = row.preferences[0];
          return toVoiceCredential({
            ...row,
            isDefault: preference?.isDefault ?? false,
            voiceId: preference?.voiceId ?? "",
          });
        });
      }),
      connect: authed.voice.connect.handler(async ({ context, input }) =>
        persistVoiceCredential(deps, context.actor, {
          provider: input.provider,
          plaintext: input.apiKey,
          voiceId: input.voiceId,
          signal: context.signal,
        }),
      ),
      disconnect: authed.voice.disconnect.handler(async ({ context, input }) =>
        disconnectVoiceCredential(deps, context.actor, { provider: input.provider }),
      ),
      setVoice: authed.voice.setVoice.handler(async ({ context, input }) => {
        const cred = await withSerializableRetry(() =>
          deps.prisma.$transaction(
            async (tx) => {
              const found = input.provider
                ? await tx.userVoiceCredential.findFirst({
                    where: { userId: context.actor.userId, provider: input.provider },
                    orderBy: newestVoiceCredentialOrder,
                  })
                : (
                    await tx.spaceVoicePreference.findFirst({
                      where: {
                        userId: context.actor.userId,
                        spaceId: context.actor.spaceId,
                        isDefault: true,
                      },
                      include: { credential: true },
                      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
                    })
                  )?.credential;
              if (!found) {
                throw new ORPCError("BAD_REQUEST", { message: "Connect a voice provider first." });
              }
              // Picking a voice also makes its provider the one speak/transcribe use.
              await selectSpaceVoicePreference(tx, context.actor, found.id, input.voiceId);
              return { ...found, voiceId: input.voiceId, isDefault: true };
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
        );
        return toVoiceStatus(cred);
      }),
      voices: authed.voice.voices.handler(async ({ context, input }) => {
        const loaded = await loadDefaultVoiceCredential(deps, context.actor);
        if (!loaded) return [];
        const providerId = input.provider ?? loaded.cred.provider;
        const row =
          providerId === loaded.cred.provider
            ? loaded
            : await loadVoiceCredential(deps, context.actor, providerId);
        if (!row) return [];
        return createVoiceProvider(row.cred.provider).listVoices(
          row.apiKey,
          voiceContext(context.actor, context.signal),
        );
      }),
      prepare: authed.voice.prepare.handler(async ({ context, input }) =>
        prepareVoice(deps, context.actor, input),
      ),
    },
  };
}
