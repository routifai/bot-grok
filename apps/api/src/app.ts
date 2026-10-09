import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type {
  JobPublisher,
  ManagedConnectorProvider,
  MessagingSurface,
  RealtimeFanout,
  SandboxProvider,
  TransactionalEmailProvider,
} from "@nova/adapter-kit";
import type {
  ComposioProvider,
  ConnectorRegistry,
  DestinationEmulator,
  RemoteConnectorDependencies,
} from "@nova/adapters";
import {
  applyMessagingOutboundStatus,
  ChatSdkMessagingSurface,
  ComposioConnector,
  createBackgroundJobHandlers,
  createConnectorStack,
  createJobReconciler,
  createRunSandbox,
  createRunSecretWriter,
  destroyBot,
  destroyPersonalComputers,
  EmailEmulator,
  EncryptedSecretStore,
  GraphileJobPublisher,
  HttpEmailProvider,
  InMemoryJobQueue,
  InMemoryRealtimeFanout,
  InstalledConnectorProvider,
  IntegrationProviderSettings,
  identityMaintenance,
  isComposioEnabled,
  isMessagingSurfaceEnabled,
  isPipedreamEnabled,
  LocalAgentHomeStore,
  LocalArtifactStore,
  McpConnector,
  McpOAuthBroker,
  messagingPlatformsFromEnv,
  omnigentGatewayDepsFromEnv,
  omnigentRedactionSecretsFromEnv,
  PiOAuthLogins,
  PipedreamConnector,
  PostgresRealtimeFanout,
  pipedreamConfigFromEnv,
  pushTokenPath,
  reconcileComputerUpdates,
  SmtpEmailProvider,
  sandboxProviderOptionsFromEnv,
  stopSpaceComputers,
} from "@nova/adapters";
import {
  assertIdentityConfig,
  blockedAuthPaths,
  createAuth,
  isHostedDeployment,
  oidcLabel,
  resolveSignupPolicy,
} from "@nova/auth";
import { signupAllowlistBootUpdate, signupPolicyFromEnv } from "@nova/core";
import type { Pool, PrismaClient } from "@nova/db";
import {
  createDb,
  createPool,
  createThreadEvents,
  parsePositiveInteger,
  provisionMessagingIdentity,
  requireMembership,
  userMayAct,
} from "@nova/db";
import type { Logger } from "@nova/logging";
import {
  createServiceLogger,
  enrichLogContext,
  getLogger,
  installLogger,
  SERVICE_NAMES,
} from "@nova/logging";
import { requestLogging } from "@nova/logging/hono";
import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { engineComputerClient } from "./engine-client.js";
import type { AppEnv } from "./env.js";
import { loadEnv } from "./env.js";
import { setEngineAccountSuspended } from "./features/admin/service.js";
import { mountPublishedApps } from "./features/apps/published-apps.js";
import { mountScreenTarget } from "./features/computer/screen-proxy.js";
import { mountLocalSettings } from "./local-settings.js";
import { createMessagingInboundHandler } from "./messaging-inbound.js";
import { mountMessagingWebhookRoutes } from "./messaging-webhook.js";
import { mountApiRequestBodyLimits } from "./request-body-limit.js";
import { createRouter } from "./router.js";
import { mountVoiceHttpRoutes } from "./voice.js";
import { mountWebhookHttpRoutes } from "./webhook.js";

export interface AppHandles {
  app: Hono;
  prisma: PrismaClient;
  jobs: JobPublisher;
  sandbox: SandboxProvider;
  connector: DestinationEmulator;
  composio?: ComposioProvider;
  connectors: ConnectorRegistry;
  messaging?: MessagingSurface;
  email?: TransactionalEmailProvider;
  stop: () => Promise<void>;
}

export async function createApp(
  overrides: Partial<AppEnv> & {
    prisma?: PrismaClient;
    realtime?: RealtimeFanout;
    sandbox?: SandboxProvider;
    composio?: ComposioProvider;
    pipedream?: ManagedConnectorProvider;
    messaging?: MessagingSurface;
    email?: TransactionalEmailProvider;
    remoteConnectors?: RemoteConnectorDependencies;
    logger?: Logger;
  } = {},
): Promise<AppHandles> {
  const {
    prisma: prismaOverride,
    realtime: realtimeOverride,
    sandbox: sandboxOverride,
    composio: composioOverride,
    pipedream: pipedreamOverride,
    messaging: messagingOverride,
    email: emailOverride,
    remoteConnectors,
    logger: loggerOverride,
    ...envOverrides
  } = overrides;
  const env = { ...loadEnv(process.env), ...envOverrides };
  const logger = loggerOverride ?? createServiceLogger({ service: SERVICE_NAMES.api });
  installLogger(logger);
  const created = prismaOverride
    ? { prisma: prismaOverride, pool: undefined }
    : createDb(env.databaseUrl, {
        poolMax: parsePositiveInteger(process.env.DB_POOL_MAX, 4),
        applicationName: "nova-api",
      });
  const { prisma } = created;
  const realtime =
    realtimeOverride ??
    (created.pool
      ? new PostgresRealtimeFanout({
          connectionString: env.realtimeDatabaseUrl,
          publisher: created.pool,
        })
      : new InMemoryRealtimeFanout());
  const secrets = new EncryptedSecretStore(env.encryptionKey);
  const events = createThreadEvents(prisma, realtime, {
    runSecretWriter: createRunSecretWriter(secrets),
  });
  const localEmailEmulator =
    !emailOverride && !env.smtpUrl && !env.emailApiUrl && env.emailEmulator
      ? new EmailEmulator((message) => {
          getLogger().info("email emulator captured message", {
            "email.subject": message.subject,
          });
        })
      : undefined;
  if (localEmailEmulator && !isLoopbackHost(env.apiHost)) {
    throw new Error("EMAIL_EMULATOR requires API_HOST to be a loopback host");
  }
  const email: TransactionalEmailProvider | undefined =
    emailOverride ??
    (env.smtpUrl
      ? new SmtpEmailProvider({ url: env.smtpUrl, from: env.emailFrom ?? "" })
      : env.emailApiUrl
        ? new HttpEmailProvider({
            url: env.emailApiUrl,
            apiKey: env.emailApiKey ?? "",
            from: env.emailFrom ?? "",
          })
        : localEmailEmulator);
  // Fail at startup, before anything is seeded, not at the first stranger's signup.
  const existingSettings = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
  assertIdentityConfig(
    {
      hosted: isHostedDeployment(env),
      allowUnverifiedEmail: env.allowUnverifiedEmail,
      ownerSetupToken: env.ownerSetupToken,
      hasEmail: Boolean(email),
      ownerExists: Boolean(existingSettings?.ownerUserId),
      clientIpConfigured: env.trustedProxies.length > 0 || Boolean(env.clientIpHeader),
    },
    await resolveSignupPolicy(prisma, env),
  );
  if (env.allowUnverifiedEmail && !email) {
    getLogger().warn(
      "AUTH_ALLOW_UNVERIFIED_EMAIL is on: accounts are usable without proving their email. Local installs only.",
    );
  }
  // One rule for "may this person act now", shared with the session lookup: active, and either
  // the mailbox is proved or nothing can prove one and the deployment's rule lets them in.
  const gateRule = { devFlagAllowed: env.allowUnverifiedEmail && !isHostedDeployment(env) };
  const mayAct = (userId: string) => userMayAct(prisma, userId, gateRule);
  const environmentSignupPolicy = signupPolicyFromEnv(env);
  const deploymentSettings = await prisma.deploymentSettings.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      signupMode: environmentSignupPolicy.mode,
      signupsEnabled: environmentSignupPolicy.mode !== "closed",
      signupAllowlist: environmentSignupPolicy.invites.join(","),
      signupDomains: environmentSignupPolicy.domains.join(","),
      signupPolicyInitialized: true,
    },
    update: {},
  });
  // Recorded for the other processes (the worker) so everyone applies one "may an unverified
  // person act" rule.
  await prisma.deploymentSettings.update({
    where: { id: "default" },
    data: { emailDelivery: Boolean(email) },
  });
  if (!deploymentSettings.signupPolicyInitialized) {
    // Older versions created this row with schema defaults even though auth
    // still enforced the environment policy. Copy that effective policy once
    // so upgrades preserve behavior. Later starts reapply a non-empty
    // SIGNUP_ALLOWLIST; a blank value leaves the stored list alone.
    await prisma.deploymentSettings.updateMany({
      where: { id: "default", signupPolicyInitialized: false },
      data: {
        signupMode: environmentSignupPolicy.mode,
        signupsEnabled: environmentSignupPolicy.mode !== "closed",
        signupAllowlist: environmentSignupPolicy.invites.join(","),
        signupDomains: environmentSignupPolicy.domains.join(","),
        signupPolicyInitialized: true,
      },
    });
  } else {
    const signupAllowlist = signupAllowlistBootUpdate(
      deploymentSettings.signupAllowlist,
      env.signupAllowlist,
      true,
    );
    if (signupAllowlist !== null) {
      await prisma.deploymentSettings.update({
        where: { id: "default" },
        data: { signupAllowlist },
      });
      logger.info("applied SIGNUP_ALLOWLIST from the environment");
    }
  }

  const jobKind = env.wakeupDriver;
  const inMemoryJobs = jobKind === "memory" ? new InMemoryJobQueue() : undefined;
  // prismaOverride skips createDb, so there is no shared pool. The previous
  // GraphileJobPublisher(databaseUrl) path opened its own connections; keep a
  // bounded pool for that override path instead of passing undefined.
  let ownedJobPool: Pool | undefined;
  if (!inMemoryJobs && !created.pool) {
    ownedJobPool = createPool(env.databaseUrl, {
      poolMax: parsePositiveInteger(process.env.DB_POOL_MAX, 4),
      applicationName: "nova-api-jobs",
    });
  }
  const jobPool = created.pool ?? ownedJobPool;
  const jobs = inMemoryJobs
    ? inMemoryJobs
    : new GraphileJobPublisher(
        jobPool ??
          (() => {
            throw new Error("Graphile job publisher requires a PostgreSQL pool");
          })(),
      );
  const sandbox: SandboxProvider =
    sandboxOverride ??
    createRunSandbox(env.sandboxProvider, {
      ...sandboxProviderOptionsFromEnv(),
      supervisorUrl: env.sandboxSupervisorUrl,
      supervisorToken: env.sandboxSupervisorToken,
      e2bApiKey: env.e2bApiKey,
      daytonaApiKey: env.daytonaApiKey,
      daytonaApiUrl: env.daytonaApiUrl,
      daytonaTarget: env.daytonaTarget,
      boxApiKey: env.boxApiKey,
      boxApiUrl: env.boxApiUrl,
      dataDir: env.dataDir,
      prisma,
    });
  const mcpOAuth = new McpOAuthBroker(
    prisma,
    secrets,
    remoteConnectors,
    env.mcpAllowPrivateEndpoint,
  );
  const oauthLogins = new PiOAuthLogins();
  const home = new LocalAgentHomeStore(env.dataDir);
  const artifacts = new LocalArtifactStore(env.dataDir);
  const mcp = new McpConnector(
    prisma,
    secrets,
    {
      stdioEnabled: env.mcpStdioEnabled,
      allowedCommands: env.mcpStdioAllowedCommands,
      network: remoteConnectors,
      events,
      allowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
    },
    mcpOAuth,
  );
  const pipedreamConfig = pipedreamConfigFromEnv(env);
  const pipedream =
    pipedreamOverride ??
    (isPipedreamEnabled(pipedreamConfig) ? new PipedreamConnector(pipedreamConfig) : undefined);
  // This process registers the inbound sink (messaging.onInbound below),
  // so it's the one that must hold Telegram's live getUpdates connection —
  // see messagingPlatformsFromEnv's docstring for why a second poller
  // elsewhere (e.g. the worker) would actively break this.
  const messagingPlatforms = messagingPlatformsFromEnv(env, { pollInboundMessages: true });
  const messaging =
    messagingOverride ??
    (isMessagingSurfaceEnabled(messagingPlatforms, {
      deploymentModelKey: env.deploymentModelKey,
      openSignup: env.messagingOpenSignup,
    })
      ? new ChatSdkMessagingSurface(messagingPlatforms)
      : undefined);
  const installed = new InstalledConnectorProvider(prisma, secrets, remoteConnectors);
  const integrationSettings = new IntegrationProviderSettings(prisma, secrets, env.encryptionKey, {
    composio:
      composioOverride ??
      (isComposioEnabled(env.composioApiKey)
        ? new ComposioConnector(env.composioApiKey)
        : undefined),
    pipedream,
  });
  const stack = createConnectorStack(false, composioOverride, [
    installed,
    ...integrationSettings
      .providers()
      .filter((provider) => !composioOverride || provider.describe().id !== "composio"),
    mcp,
  ]);
  const connector = stack.destination;
  await connector.start();
  integrationSettings.warmDirectories();
  const auth = createAuth(prisma, {
    secret: env.authSecret,
    baseURL: env.authUrl,
    webOrigin: env.webOrigin,
    signupMode: env.signupMode,
    signupsEnabled: env.signupsEnabled,
    signupAllowlist: env.signupAllowlist,
    signupDomains: env.signupDomains,
    nodeEnv: env.nodeEnv,
    allowUnverifiedEmail: env.allowUnverifiedEmail,
    oidc: env.oidc,
    ownerSetupToken: env.ownerSetupToken,
    trustedProxies: env.trustedProxies,
    clientIpHeader: env.clientIpHeader,
    rateLimit: env.rateLimit,
    email,
    onEmailError: (error) => getLogger().error("transactional email delivery failed", error),
    extraOrigins: [
      "nova://",
      "exp://",
      "exp://*",
      "http://localhost:8081",
      "http://127.0.0.1:8081",
      "http://localhost:19006",
      "http://127.0.0.1:19006",
    ],
    beforeDeleteUser: async (userId) => {
      const bots = await prisma.bot.findMany({
        where: { userId },
        select: { id: true, userId: true, spaceId: true, name: true, archivedAt: true },
      });
      await Promise.all(
        bots.map((bot) =>
          destroyBot(
            { prisma, sandbox, home, jobs, artifacts, dataDir: env.dataDir },
            bot,
            {
              operationId: `account-delete:${userId}`,
              traceId: `account-delete:${userId}`,
              spaceId: bot.spaceId,
              userId,
              botId: bot.id,
              signal: new AbortController().signal,
            },
            { deleteMemories: true },
          ),
        ),
      );
      // The team Computer is not any one bot's: destroy it too, before its rows are erased.
      await destroyPersonalComputers({ prisma, sandbox }, userId);
      await rm(pushTokenPath(env.dataDir, userId), { force: true }).catch(() => undefined);
    },
    beforeQuarantine: (userId, spaceIds) =>
      stopSpaceComputers({ prisma, sandbox }, spaceIds, `quarantine:${userId}`),
    afterQuarantine: async ({ userId, email, organizationIds, stopFailed }) => {
      // The admin log is not built yet (audit is a later phase); this line is the record.
      getLogger().warn("quarantined a space after its mailbox was proved", {
        "user.id": userId,
        "identity.organizations": organizationIds.join(","),
        "identity.computers_stop_failed": stopFailed,
      });
      try {
        const outcome = await setEngineAccountSuspended(
          { prisma },
          engineComputerClient({ spaceId: "identity" }),
          email,
          true,
        );
        if (outcome !== "done") {
          getLogger().warn(`engine account not paused after quarantine: ${outcome}`, {
            "user.id": userId,
          });
        }
      } catch (error) {
        // Most often: the deployment owner is not an engine admin, so the engine refused.
        getLogger().warn(
          "could not pause the engine account after quarantine (is the deployment owner an engine admin?)",
          { "user.id": userId, error: error instanceof Error ? error.message : String(error) },
        );
      }
    },
  });
  // Same composition ./omnigent/env.ts#omnigentRedactionSecretsFromEnv uses for the Omnigent
  // read paths (chats.*/activities.*/memory.profile) — one list, shared, so every surface that
  // can echo back something Omnigent said redacts with the identical
  // set of deployment secrets.
  const runtimeSecrets = omnigentRedactionSecretsFromEnv(process.env);
  const omnigent = omnigentGatewayDepsFromEnv(process.env, prisma, events, runtimeSecrets);
  const jobHandlers = createBackgroundJobHandlers({
    userMayAct: mayAct,
    prisma,
    sandbox,
    home,
    jobs,
    events,
    workerId: "api",
    messaging,
    omnigent,
  });
  if (inMemoryJobs) {
    await inMemoryJobs.start(jobHandlers);
  }
  const reconciler = inMemoryJobs
    ? createJobReconciler({
        prisma,
        jobs,
        reconcileComputerUpdates: () => reconcileComputerUpdates({ prisma, jobs }),
        identityMaintenance: () => identityMaintenance({ prisma, sandbox }),
      })
    : undefined;
  reconciler?.start();

  const router = createRouter({
    prisma,
    events,
    auth,
    jobs,
    sandbox,
    home,
    secrets,
    oauthLogins,
    integrationSettings,
    mcpOAuth,
    composio: stack.composio,
    connectors: stack.connector,
    remoteConnectors,
    artifacts,
    dataDir: env.dataDir,
    identity: {
      signupPolicy: env,
      production: isHostedDeployment(env),
      emailDelivery: Boolean(email),
    },
    messaging: {
      enabled: Boolean(messaging),
      providers: messaging?.platforms().map((platform) => platform.provider) ?? [],
      openSignup: env.messagingOpenSignup,
    },
    env: {
      agentRuntime: env.agentRuntime,
      defaultProvider: env.defaultProvider,
      defaultModel: env.defaultModel,
      deploymentModelKey: env.deploymentModelKey,
      webOrigin: env.webOrigin,
      privacyPolicyUrl: env.privacyPolicyUrl,
      screenProxySecret: env.screenProxySecret,
      sandboxProvider: env.sandboxProvider,
      integrationsCatalogUrl: env.integrationsCatalogUrl,
      mcpAllowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
    },
  });
  const rpc = new RPCHandler(router, {
    clientInterceptors: [onError((error, { path }) => logUnexpectedRpcError(error, path))],
  });
  const app = new Hono();
  app.use("*", requestLogging(logger));
  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) return env.webOrigin;
        return isTrustedOrigin(origin, env) ? origin : "";
      },
      credentials: true,
    }),
  );
  app.get("/api/auth/capabilities", async (c) => {
    const policy = await resolveSignupPolicy(prisma, env);
    const settings = await prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { ownerUserId: true },
    });
    return c.json({
      passwordReset: Boolean(email),
      resetUrl: email ? new URL("/reset-password", env.webOrigin).href : null,
      // Mailbox proof by one-time code works wherever mail can be sent.
      emailCode: Boolean(email),
      sso: env.oidc ? { name: oidcLabel(env.oidc) } : null,
      signupMode: policy.mode,
      // The owner seat is claimed with the operator's setup token until someone holds it.
      ownerSetup:
        Boolean(env.ownerSetupToken) && policy.mode !== "closed" && !settings?.ownerUserId,
    });
  });
  if (localEmailEmulator && env.nodeEnv === "development") {
    app.get(
      "/api/dev/emails",
      () =>
        new Response(JSON.stringify(localEmailEmulator.sent), {
          headers: { "cache-control": "no-store", "content-type": "application/json" },
        }),
    );
  }
  mountApiRequestBodyLimits(app);
  mountScreenTarget(app, prisma, env.screenProxySecret, mayAct);
  mountPublishedApps(app, {
    prisma,
    secret: env.authSecret,
    // The engine only needs the connection for /v1/published; the tenant is not used there.
    engine: () => engineComputerClient({ spaceId: "apps-gateway" }),
    // An app stops being served once its owner may no longer act (suspended, waiting, quarantined).
    ownerMayAct: async (ownerEmail) => {
      const owner = await prisma.user.findFirst({
        where: { email: { equals: ownerEmail, mode: "insensitive" } },
        select: { id: true },
      });
      return owner ? mayAct(owner.id) : false;
    },
    viewer: async (c) => {
      const session = await auth.api.getSession({ headers: sessionHeaders(c.req.raw) });
      if (!session?.user || !(await mayAct(session.user.id))) return null;
      return { userId: session.user.id, email: session.user.email };
    },
    onError: (error) => logUnexpectedRpcError(error, ["apps"]),
  });
  app.on(["GET", "POST"], "/api/auth/*", async (c) => {
    const path = new URL(c.req.url).pathname.replace("/api/auth", "");
    if (blockedAuthPaths.some((blocked) => path.startsWith(blocked))) {
      return c.json({ error: "Not available in version 1" }, 404);
    }
    return auth.handler(c.req.raw);
  });
  mountLocalSettings(app, { token: env.desktopStackToken, prisma, rpc });
  app.use("/rpc/*", async (c, next) => {
    const session = await auth.api.getSession({ headers: sessionHeaders(c.req.raw) });
    const requestedSpaceId = c.req.header("x-nova-space-id");
    const actor = session?.user
      ? await requireMembership(prisma, session.user.id, requestedSpaceId).catch(() => null)
      : null;
    if (actor) {
      enrichLogContext({ "user.id": actor.userId, "space.id": actor.spaceId });
    }
    const suspension = actor
      ? endWhenInactive(mayAct, actor.userId, c.req.raw.signal)
      : { signal: c.req.raw.signal, stop: () => undefined };
    const { matched, response } = await rpc.handle(c.req.raw, {
      prefix: "/rpc",
      context: { actor, signal: suspension.signal },
    });
    // Only a live stream keeps watching; a finished request has nothing left to end.
    if (!response?.headers.get("content-type")?.includes("text/event-stream")) suspension.stop();
    if (matched) return c.newResponse(response.body, response);
    await next();
  });
  mountVoiceHttpRoutes(app, { prisma, secrets }, async (c) => {
    const session = await auth.api.getSession({ headers: sessionHeaders(c.req.raw) });
    if (!session?.user || !(await mayAct(session.user.id))) return null;
    const actor = await requireMembership(
      prisma,
      session.user.id,
      c.req.header("x-nova-space-id"),
    ).catch(() => null);
    if (actor) enrichLogContext({ "user.id": actor.userId, "space.id": actor.spaceId });
    return actor;
  });
  mountWebhookHttpRoutes(app, { prisma, secrets, events, jobs });
  // Shared with stop so a shutdown during retry delays does not restart polling.
  let messagingStopped = false;
  let clearMessagingRetryDelay: (() => void) | undefined;
  let messagingInitTask: Promise<void> | undefined;
  // Messaging webhooks only exist when the surface is enabled.
  if (messaging) {
    const inboundDeps = {
      userMayAct: mayAct,
      prisma,
      events,
      jobs,
      provision: (request, policyEnv) => provisionMessagingIdentity(prisma, request, policyEnv),
      openSignup: env.messagingOpenSignup,
      signupPolicy: {
        signupMode: env.signupMode,
        signupsEnabled: env.signupsEnabled,
        signupAllowlist: env.signupAllowlist,
        signupDomains: env.signupDomains,
      },
      typing: (threadId) => {
        // Keep conversation addresses out of trace ids — those reach logs
        // and telemetry, a different trust boundary than the database.
        const operationId = `messaging.typing:${randomUUID()}`;
        return messaging.sendTyping(threadId, {
          operationId,
          traceId: operationId,
          spaceId: "",
          userId: "",
          // Cosmetic side call: the wait is bounded so a stalled vendor
          // response never holds our callback chain (the Chat SDK adapter
          // API cannot cancel the underlying request itself).
          signal: AbortSignal.timeout(2000),
        });
      },
    } satisfies Parameters<typeof createMessagingInboundHandler>[0];
    const inbound = createMessagingInboundHandler(inboundDeps);
    messaging.onInbound(async (event) => {
      if (event.type !== "message") {
        await applyMessagingOutboundStatus(prisma, event);
        return;
      }
      await inbound(event);
    });
    mountMessagingWebhookRoutes(app, { messaging });
    // Start polling-mode adapters (e.g. Telegram with no public webhook URL
    // registered) immediately rather than waiting for the first webhook
    // POST or outbound send to lazily trigger it. This is the process that
    // owns the inbound sink registered just above, so it must be the one
    // holding the live connection — a second poller elsewhere (e.g. the
    // worker) would only fight this one for Telegram's single getUpdates
    // slot without ever seeing the messages itself.
    // Bounded retries cover transient Telegram startup failures; polling-only
    // bots otherwise stay dark until an unrelated outbound send re-inits.
    messagingInitTask = (async () => {
      const delayMs = [0, 2_000, 10_000];
      for (let attempt = 0; attempt < delayMs.length; attempt += 1) {
        if (messagingStopped) return;
        if (delayMs[attempt]! > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delayMs[attempt]);
            clearMessagingRetryDelay = () => {
              clearTimeout(timer);
              clearMessagingRetryDelay = undefined;
              resolve();
            };
          });
          clearMessagingRetryDelay = undefined;
        }
        if (messagingStopped) return;
        try {
          await messaging.initialize?.();
          return;
        } catch (error) {
          getLogger().error(
            attempt === delayMs.length - 1
              ? "messaging surface initialize failed"
              : "messaging surface initialize failed; retrying",
            error,
          );
        }
      }
    })();
  }

  app.get("/health", (c) =>
    c.json({
      ok: true,
      runtime: env.agentRuntime,
      sandbox: env.sandboxProvider,
      composio: Boolean(stack.composio),
      pipedream: Boolean(pipedream),
      messaging: Boolean(messaging),
      email: email?.describe().id ?? null,
      jobs: jobKind,
      realtime: realtime.describe().id,
      revision: env.gitSha ?? null,
    }),
  );

  return {
    app,
    prisma,
    jobs,
    sandbox,
    connector,
    composio: stack.composio,
    connectors: stack.connector,
    messaging,
    email,
    stop: async () => {
      oauthLogins.abortAll();
      messagingStopped = true;
      clearMessagingRetryDelay?.();
      await messagingInitTask?.catch(() => undefined);
      await messaging?.shutdown?.();
      await email?.drain?.();
      await reconciler?.stop();
      await jobs.close();
      await realtime.close();
      await connector.stop();
      await mcp.close();
      await prisma.$disconnect().catch(() => undefined);
      await created.pool?.end().catch(() => undefined);
      await ownedJobPool?.end().catch(() => undefined);
      await logger.flush({ timeoutMs: 2_000 });
    },
  };
}

function isTrustedOrigin(origin: string, env: AppEnv) {
  if (!origin) return true;
  if (origin === env.webOrigin || origin === env.apiUrl || origin === env.authUrl) return true;
  if (origin.startsWith("nova://") || origin.startsWith("exp://")) return true;
  try {
    const host = new URL(origin).hostname;
    return isLoopbackHost(host);
  } catch {
    return false;
  }
}

/**
 * A long-lived stream is authorized once, at its start. This aborts the request's signal as soon as
 * the account stops being active, so a suspended person's open streams end instead of running on.
 */
function endWhenInactive(
  mayAct: (userId: string) => Promise<boolean>,
  userId: string,
  requestSignal: AbortSignal,
  intervalMs = 15_000,
): { signal: AbortSignal; stop: () => void } {
  const controller = new AbortController();
  const timer = setInterval(() => {
    void mayAct(userId)
      .then((allowed) => {
        if (!allowed) controller.abort();
      })
      .catch(() => undefined);
  }, intervalMs);
  timer.unref();
  const stop = () => clearInterval(timer);
  requestSignal.addEventListener("abort", stop, { once: true });
  controller.signal.addEventListener("abort", stop, { once: true });
  return { signal: AbortSignal.any([requestSignal, controller.signal]), stop };
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function sessionHeaders(request: Request) {
  const headers = new Headers(request.headers);
  const authz = headers.get("authorization");
  if (authz?.toLowerCase().startsWith("bearer ") && !headers.get("cookie")) {
    headers.set("cookie", `better-auth.session_token=${authz.slice(7).trim()}`);
  }
  return headers;
}

/**
 * An ORPCError is a decision the router made (BAD_REQUEST, UNAUTHORIZED, ...) and reaches the
 * caller intact. Everything else is flattened into an opaque "Internal server error", so
 * unless it is logged here the only record of what actually broke is gone.
 *
 * The cause chain matters as much as the message: undici and most SDKs report a bare
 * "fetch failed" and keep the host and errno one level down.
 */
export function logUnexpectedRpcError(error: unknown, path: readonly string[]): void {
  if (error instanceof ORPCError) return;
  const where = `rpc ${path.join("/")} failed`;
  getLogger().error(where, error);
}
