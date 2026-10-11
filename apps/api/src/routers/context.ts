import { type ImplementerInternalWithMiddlewares, implement, ORPCError } from "@orpc/server";
import type {
  AgentHomeStore,
  ArtifactStore,
  JobPublisher,
  SandboxProvider,
} from "@superchat/adapter-kit";
import type {
  ComposioProvider,
  ConnectorRegistry,
  EncryptedSecretStore,
  IntegrationProviderSettings,
  PiOAuthLogins,
  RemoteConnectorDependencies,
} from "@superchat/adapters";
import { McpOAuthBroker } from "@superchat/adapters";
import type { Auth } from "@superchat/auth";
import type { Actor } from "@superchat/contracts";
import { appContract } from "@superchat/contracts";
import type { PrismaClient, SignupPolicyEnv, ThreadEvents } from "@superchat/db";
import { createGroupRepos, createRepos } from "@superchat/db";
import type { EngineArtifactsDeps } from "../features/artifacts/index.js";
import { withEngineComputer } from "../features/computer/service.js";
import { createAgentSkillsService } from "../features/skills/agent-skills.js";

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
  /** Identity settings the signup admin needs; absent in unit fixtures that do not touch it. */
  identity?: {
    /** Environment seed, used only if the settings row has to be created. */
    signupPolicy: SignupPolicyEnv;
    production: boolean;
    emailDelivery: boolean;
  };
  /** Present when the external messaging surface is enabled. */
  messaging?: { enabled: boolean; providers: string[]; openSignup: boolean };
  env: {
    agentRuntime: string;
    defaultProvider: string;
    defaultModel: string;
    deploymentModelKey?: string;
    webOrigin: string;
    privacyPolicyUrl?: string;
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
  agentSkills: ReturnType<typeof createAgentSkillsService>;
  engineArtifactsDeps: EngineArtifactsDeps;
  engineFilesDeps: { prisma: RouterDeps["prisma"] };
  /** A thread snapshot with its Computer as the engine sees it. */
  withComputer<T extends Parameters<typeof withEngineComputer>[2]>(
    actor: Actor,
    snapshot: T,
  ): Promise<T>;
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
  const agentSkills = createAgentSkillsService(deps.prisma);

  const authed = makeAuthed(os);
  // Muse is the only edition now; these routes (Asks, followed topics, Muse settings) no longer need a mode gate, but the alias documents intent.
  const museOnly = authed;
  const engineArtifactsDeps: EngineArtifactsDeps = { prisma: deps.prisma };
  const engineFilesDeps = { prisma: deps.prisma };
  return {
    deps,
    os,
    authed,
    museOnly,
    repos,
    groupRepos,
    onboardingDeps,
    mcpOAuth,
    agentSkills,
    engineArtifactsDeps,
    engineFilesDeps,
    withComputer: (actor, snapshot) => withEngineComputer(deps, actor, snapshot),
  };
}
