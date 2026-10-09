import type {
  AgentHomeStore,
  ArtifactStore,
  JobPublisher,
  SandboxProvider,
} from "@nova/adapter-kit";
import { runContinueJob } from "@nova/adapter-kit";
import type {
  ComposioProvider,
  ConnectorRegistry,
  EncryptedSecretStore,
  IntegrationProviderSettings,
  PiOAuthLogins,
  RemoteConnectorDependencies,
} from "@nova/adapters";
import { McpOAuthBroker } from "@nova/adapters";
import type { Auth } from "@nova/auth";
import type { Actor } from "@nova/contracts";
import { appContract } from "@nova/contracts";
import type { PrismaClient, ThreadEvents } from "@nova/db";
import { createGroupRepos, createRepos, IsolationError } from "@nova/db";
import { getLogger } from "@nova/logging";
import { type ImplementerInternalWithMiddlewares, implement, ORPCError } from "@orpc/server";
import type { EngineArtifactsDeps } from "../features/artifacts/index.js";
import { withEngineComputer } from "../features/computer/service.js";
import type { EngineIdeasDeps } from "../features/ideas/service.js";
import { createAgentSkillsService } from "../features/skills/agent-skills.js";
import { createTaughtSkillsService } from "../features/skills/taught-skills.js";
import { assertTeachingSendAllowed } from "../teaching-guard.js";
import { resolveThreadTarget } from "../thread-target.js";

export interface RouterDeps {
  prisma: PrismaClient;
  events: ThreadEvents;
  auth: Auth;
  jobs: JobPublisher;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  secrets: EncryptedSecretStore;
  oauthLogins: PiOAuthLogins;
  integrationSettings?: IntegrationProviderSettings;
  composio?: ComposioProvider;
  mcpOAuth?: McpOAuthBroker;
  connectors: ConnectorRegistry;
  remoteConnectors?: RemoteConnectorDependencies;
  artifacts: ArtifactStore;
  dataDir: string;
  /** Present when the external messaging surface is enabled. */
  messaging?: { enabled: boolean; providers: string[]; openSignup: boolean };
  env: {
    agentRuntime: string;
    defaultProvider: string;
    defaultModel: string;
    deploymentModelKey?: string;
    webOrigin: string;
    privacyPolicyUrl?: string;
    screenProxySecret: string;
    sandboxProvider: string;
    integrationsCatalogUrl?: string;
    mcpAllowPrivateEndpoint?: boolean;
  };
}

function makeOs() {
  return implement(appContract).$context<{ actor: Actor | null; signal?: AbortSignal }>();
}
export type RouterOs = ReturnType<typeof makeOs>;

// Spelled out: inferred, the contract's full type is too large for the declaration emitter (TS7056).
type AuthedImplementer = ImplementerInternalWithMiddlewares<
  typeof appContract,
  { actor: Actor | null; signal?: AbortSignal },
  { actor: Actor; signal?: AbortSignal }
>;

function makeAuthed(os: RouterOs): AuthedImplementer {
  return os.use(async ({ context, next }) => {
    if (!context.actor) throw new ORPCError("UNAUTHORIZED");
    return next({ context: { ...context, actor: context.actor } });
  });
}
export type RouterAuthed = ReturnType<typeof makeAuthed>;

export interface RouterContext {
  deps: RouterDeps;
  os: RouterOs;
  authed: RouterAuthed;
  museOnly: RouterAuthed;
  repos: ReturnType<typeof createRepos>;
  groupRepos: ReturnType<typeof createGroupRepos>;
  onboardingDeps: Pick<RouterDeps, "prisma" | "events" | "connectors">;
  mcpOAuth: McpOAuthBroker;
  taughtSkills: ReturnType<typeof createTaughtSkillsService>;
  agentSkills: ReturnType<typeof createAgentSkillsService>;
  engineArtifactsDeps: EngineArtifactsDeps;
  engineFilesDeps: { prisma: RouterDeps["prisma"] };
  /** A thread snapshot with its Computer as the engine sees it. */
  withComputer<T extends Parameters<typeof withEngineComputer>[2]>(
    actor: Actor,
    snapshot: T,
  ): Promise<T>;
  engineIdeasDeps: EngineIdeasDeps;
}

export function createRouterContext(deps: RouterDeps): RouterContext {
  const os = makeOs();
  const repos = createRepos(deps.prisma);
  const onboardingDeps = {
    prisma: deps.prisma,
    events: deps.events,
    connectors: deps.connectors,
  };
  const mcpOAuth = deps.mcpOAuth ?? new McpOAuthBroker(deps.prisma, deps.secrets);
  const groupRepos = createGroupRepos(deps.prisma);
  const taughtSkills = createTaughtSkillsService({
    prisma: deps.prisma,
    events: deps.events,
    jobs: deps.jobs,
  });
  const agentSkills = createAgentSkillsService(deps.prisma);

  const authed = makeAuthed(os);
  // Muse is the only edition now; these routes (Goals, Asks, Feed, Ideas, followed
  // topics, Muse settings) no longer need a mode gate, but the alias documents intent.
  const museOnly = authed;
  const engineArtifactsDeps: EngineArtifactsDeps = { prisma: deps.prisma };
  const engineFilesDeps = { prisma: deps.prisma };
  const engineIdeasDeps: EngineIdeasDeps = {
    prisma: deps.prisma,
    // "Do it" sends the Idea's message the same way a typed follow-up does.
    sendMessage: async (actor, botId, text) => {
      const target = await resolveThreadTarget(deps.prisma, actor, { botId });
      if (target.kind !== "bot") throw new IsolationError();
      await assertTeachingSendAllowed(deps.prisma, actor, target.botId);
      const sent = await deps.events.sendUserMessage({
        spaceId: actor.spaceId,
        threadId: target.threadId,
        botId: target.botId,
        userId: actor.userId,
        blocks: [{ kind: "text", text }],
        prompt: text,
        trigger: "follow_up",
      });
      if (sent.taskId && sent.runId) {
        await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
          getLogger().error("idea send enqueue", error);
        });
      }
    },
  };
  return {
    deps,
    os,
    authed,
    museOnly,
    repos,
    groupRepos,
    onboardingDeps,
    mcpOAuth,
    taughtSkills,
    agentSkills,
    engineArtifactsDeps,
    engineFilesDeps,
    withComputer: (actor, snapshot) => withEngineComputer(deps, actor, snapshot),
    engineIdeasDeps,
  };
}
