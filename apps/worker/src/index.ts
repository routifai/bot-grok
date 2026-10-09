import type { JobPublisher, JobWorkerHost } from "@nova/adapter-kit";
import { ComposioConnector, IntegrationProviderSettings } from "@nova/adapters";
import { loadRootEnv } from "@nova/core/node/load-root-env";

loadRootEnv();

import {
  ChatSdkMessagingSurface,
  createBackgroundJobHandlers,
  createConnectorStack,
  createJobReconciler,
  createPostgresReconciliationLeadership,
  createRunSandbox,
  createRunSecretWriter,
  databaseCapacityBackoffMs,
  EncryptedSecretStore,
  GraphileJobPublisher,
  GraphileJobWorkerHost,
  InMemoryJobQueue,
  InstalledConnectorProvider,
  identityMaintenance,
  isComposioEnabled,
  isMessagingSurfaceEnabled,
  isPipedreamEnabled,
  LocalAgentHomeStore,
  McpConnector,
  McpOAuthBroker,
  messagingEnvFromProcess,
  messagingPlatformsFromEnv,
  omnigentGatewayDepsFromEnv,
  omnigentRedactionSecretsFromEnv,
  PipedreamConnector,
  PostgresRealtimeFanout,
  pipedreamConfigFromEnv,
  reconcileComputerUpdates,
  resolveDeploymentModel,
  resolveSandboxProvider,
  sandboxProviderOptionsFromEnv,
} from "@nova/adapters";
import {
  emailDeliveryConfigured,
  isHostedDeployment,
  resolveEncryptionKey,
  resolveSupervisorToken,
} from "@nova/core";
import {
  createDb,
  createThreadEvents,
  isTooManyDatabaseConnections,
  parsePositiveInteger,
  userMayAct,
} from "@nova/db";
import { SERVICE_NAMES } from "@nova/logging";
import { createRootLogger } from "@nova/logging/axiom";

const logger = createRootLogger(SERVICE_NAMES.worker);

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  // Shared by Prisma, the reconciliation leadership lock, and both graphile-worker
  // components (see GraphileJobPublisher/GraphileJobWorkerHost) — one pool instead
  // of four separate ones. Keep this modest: graphile holds a LISTEN client and
  // leadership holds an advisory-lock client for the process lifetime, and a
  // larger max just competes for Postgres max_connections (53300).
  const { prisma, pool } = createDb(databaseUrl, {
    poolMax: parsePositiveInteger(process.env.DB_POOL_MAX, 8),
    applicationName: "nova-worker",
  });
  const realtime = new PostgresRealtimeFanout({
    connectionString: process.env.REALTIME_DATABASE_URL ?? databaseUrl,
    publisher: pool,
  });
  const secrets = new EncryptedSecretStore(resolveEncryptionKey(process.env));
  const events = createThreadEvents(prisma, realtime, {
    runSecretWriter: createRunSecretWriter(secrets),
  });
  const dataDir = process.env.DATA_DIR ?? "./data";
  // Same resolver the API uses, so both processes agree on provider, model and key.
  const { key: deploymentModelKey } = resolveDeploymentModel();
  const sandboxProvider = resolveSandboxProvider(process.env);
  const sandbox = createRunSandbox(sandboxProvider, {
    ...sandboxProviderOptionsFromEnv(process.env),
    supervisorUrl: process.env.SANDBOX_SUPERVISOR_URL ?? "http://127.0.0.1:7091",
    supervisorToken: sandboxProvider === "docker" ? resolveSupervisorToken(process.env) : undefined,
    dataDir,
    prisma,
  });
  const allowPrivateEndpoint = process.env.MCP_ALLOW_PRIVATE_ENDPOINT === "true";
  const mcpOAuth = new McpOAuthBroker(prisma, secrets, {}, allowPrivateEndpoint);
  const mcp = new McpConnector(
    prisma,
    secrets,
    {
      stdioEnabled: process.env.MCP_STDIO_ENABLED === "true",
      allowedCommands: (process.env.MCP_STDIO_ALLOWED_COMMANDS ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
      events,
      allowPrivateEndpoint,
    },
    mcpOAuth,
  );
  const pipedreamConfig = pipedreamConfigFromEnv({
    pipedreamClientId: process.env.PIPEDREAM_CLIENT_ID,
    pipedreamClientSecret: process.env.PIPEDREAM_CLIENT_SECRET,
    pipedreamProjectId: process.env.PIPEDREAM_PROJECT_ID,
    pipedreamEnvironment: process.env.PIPEDREAM_ENVIRONMENT,
    encryptionKey: resolveEncryptionKey(process.env),
  });
  const pipedream = isPipedreamEnabled(pipedreamConfig)
    ? new PipedreamConnector(pipedreamConfig)
    : undefined;
  // pollInboundMessages stays false (the default) here: this process
  // only ever sends outbound (messaging.deliver jobs). It must never poll
  // Telegram — that would steal the single getUpdates slot away from the
  // API process, which is the one with the inbound sink actually wired up.
  const messagingPlatforms = messagingPlatformsFromEnv(messagingEnvFromProcess(process.env));
  const messaging = isMessagingSurfaceEnabled(messagingPlatforms, {
    deploymentModelKey,
    openSignup: process.env.MESSAGING_OPEN_SIGNUP === "true",
  })
    ? new ChatSdkMessagingSurface(messagingPlatforms)
    : undefined;
  const integrationSettings = new IntegrationProviderSettings(
    prisma,
    secrets,
    resolveEncryptionKey(process.env),
    {
      composio: isComposioEnabled(process.env.COMPOSIO_API_KEY)
        ? new ComposioConnector(process.env.COMPOSIO_API_KEY)
        : undefined,
      pipedream,
    },
  );
  const stack = createConnectorStack(false, undefined, [
    new InstalledConnectorProvider(prisma, secrets),
    ...integrationSettings.providers(),
    mcp,
  ]);
  const connector = stack.destination;
  await connector.start();
  integrationSettings.warmDirectories();
  const home = new LocalAgentHomeStore(dataDir);
  const inMemoryJobs = process.env.WAKEUP_DRIVER === "memory" ? new InMemoryJobQueue() : undefined;
  const jobs: JobPublisher = inMemoryJobs ?? new GraphileJobPublisher(pool);
  const jobHost: JobWorkerHost =
    inMemoryJobs ??
    new GraphileJobWorkerHost(pool, {
      concurrency: parsePositiveInteger(process.env.GRAPHILE_WORKER_CONCURRENCY, 4),
    });
  // Same composition ./omnigent/env.ts#omnigentRedactionSecretsFromEnv uses for the Omnigent
  // read paths (chats.*/activities.*/memory.profile) — one list, shared, so every surface that
  // can echo back something Omnigent said redacts with the identical
  // set of deployment secrets.
  const runtimeSecrets = omnigentRedactionSecretsFromEnv(process.env);
  const omnigent = omnigentGatewayDepsFromEnv(process.env, prisma, events, runtimeSecrets);
  // The same "may this person act" rule the API applies to sessions: active, and verified or
  // allowed unverified. Whether mail can be sent is the API's recorded state, not this process's
  // own environment.
  const gateRule = {
    devFlagAllowed:
      process.env.AUTH_ALLOW_UNVERIFIED_EMAIL === "true" &&
      !isHostedDeployment({
        nodeEnv: process.env.NODE_ENV,
        webOrigin: process.env.WEB_ORIGIN ?? "http://127.0.0.1:5173",
      }),
  };
  // The API records whether mail can be sent; this process only reads it. Say so, and say when
  // this process's own environment disagrees (a likely misconfiguration of one of them).
  const recorded = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { emailDelivery: true },
  });
  const own = emailDeliveryConfigured(process.env);
  logger.info("mail delivery as recorded by the API", {
    "identity.email_delivery": recorded?.emailDelivery ?? false,
  });
  if ((recorded?.emailDelivery ?? false) !== own) {
    logger.warn(
      "this process's mail settings disagree with what the API recorded; the recorded value decides who may act while unverified",
      {
        "identity.email_delivery_recorded": recorded?.emailDelivery ?? false,
        "identity.email_delivery_env": own,
      },
    );
  }
  const jobHandlers = createBackgroundJobHandlers({
    userMayAct: (userId) => userMayAct(prisma, userId, gateRule),
    prisma,
    sandbox,
    home,
    jobs,
    events,
    workerId: process.pid.toString(),
    messaging,
    omnigent,
  });
  // graphile-worker run() connects through the shared pool. createPool already
  // retries connect() on 53300 a finite number of times. Keep retrying start
  // until Postgres has capacity: exhausting then returning from main().catch
  // left a live process that held connections but never ran jobs or registered
  // signal handlers, even after capacity returned. Do not exit(1) here; that
  // crash-loops into the same saturated Postgres. GraphileJobWorkerHost also
  // observes runner.promise after start and restarts with the same backoff if
  // the runner dies later on 53300 (unhandledRejection still swallows that
  // code so we do not Docker crash-loop on transient completeJob failures).
  for (let attempt = 0; ; attempt += 1) {
    try {
      await jobHost.start(jobHandlers);
      break;
    } catch (error) {
      if (!isTooManyDatabaseConnections(error)) throw error;
      logger.error("worker job host start waiting on database capacity", error);
      await new Promise((resolve) => setTimeout(resolve, databaseCapacityBackoffMs(attempt)));
    }
  }
  const reconciler = createJobReconciler({
    prisma,
    jobs,
    events,
    leadership: createPostgresReconciliationLeadership(pool),
    reconcileComputerUpdates: () => reconcileComputerUpdates({ prisma, jobs }),
    identityMaintenance: () => identityMaintenance({ prisma, sandbox }),
  });
  reconciler.start();

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await reconciler.stop();
      await jobHost.stop();
      await jobs.close();
      await realtime.close();
      await connector.stop();
      await mcp.close();
      await prisma.$disconnect().catch(() => undefined);
      await pool.end().catch(() => undefined);
    } finally {
      await logger.flush({ timeoutMs: 2_000 });
    }
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  // graphile-worker fires completeJob() without awaiting it. When pool.connect()
  // then hits Postgres 53300, that rejection is unhandled. Exiting here is the
  // crash loop: Docker restarts the process before Postgres has reaped the old
  // backends, so the next boot cannot connect either. Stay up on that rejection
  // only — do not resume after uncaughtException (Node leaves the process in an
  // undefined state).
  process.on("uncaughtException", (error) => {
    logger.error("uncaughtException", error);
    void stop().finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandledRejection", reason);
    if (isTooManyDatabaseConnections(reason)) return;
    void stop().finally(() => process.exit(1));
  });

  logger.info("worker ready");
}

main().catch(async (error) => {
  logger.error("worker startup failed", error);
  await logger.flush({ timeoutMs: 2_000 });
  // jobHost.start retries 53300 without bound above, so a saturated Postgres at
  // that step does not reach here. Other startup failures still exit.
  process.exit(1);
});
