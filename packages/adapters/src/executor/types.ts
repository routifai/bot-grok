// Shared types for the run executor: the ExecutorDeps injection surface consumed
// across every executor/* module.
import type {
  AgentHomeStore,
  AgentRuntime,
  ArtifactStore,
  AutoReviewProvider,
  BrowserProvider,
  ConnectorProvider,
  JobPublisher,
  ManagedConnectorProvider,
  MemoryStore,
  NotificationProvider,
  SandboxProvider,
  WebProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import type { CloudAgentConnection } from "../cloud-agent-factory.js";
import type { MemoryProviderResolver } from "../memory-provider-factory.js";
import type { RemoteTransportDependencies } from "../remote-mcp.js";
import type { EncryptedSecretStore } from "../secrets.js";

export interface ExecutorDeps {
  prisma: PrismaClient;
  events: ThreadEvents;
  runtime: AgentRuntime;
  sandbox: SandboxProvider;
  memory: MemoryStore;
  memoryProviders: MemoryProviderResolver;
  home: AgentHomeStore;
  artifacts?: ArtifactStore;
  connector?: ConnectorProvider;
  connectors?: { managed(id: string): ManagedConnectorProvider | undefined };
  secrets: string[];
  secretStore: EncryptedSecretStore;
  deploymentModelKey?: string;
  dataDir?: string;
  notifications?: NotificationProvider;
  jobs: JobPublisher;
  /** Messaging surface; absent means zero identity queries and no chat prompts. */
  messaging?: { hasIdentity(botId: string): Promise<boolean> };
  listConnectedPluginSlugs?: (userId: string) => Promise<string[]>;
  /** Builtin web_search / web_fetch. Defaults to keyless HTTP when omitted. */
  web?: WebProvider;
  /** Page browser (DOM refs) on the bot computer. Defaults to the sandbox live browser when supported. */
  browser?: BrowserProvider;
  secretHttp?: RemoteTransportDependencies;
  /** Allow RFC1918 / Docker-network MCP URLs when the deployment owner enabled the escape. */
  mcpAllowPrivateEndpoint?: boolean;
  /** Remote cloud coding agents. Null/omit means tools stay uninjected. */
  cloudAgent?: CloudAgentConnection | null;
  /** Optional Auto Review verifier. When omitted, the factory selects from env (llm | jev | scripted). */
  autoReview?: AutoReviewProvider;
  /** Aborted when createApp stop() begins so in-flight continueRun boot waits exit promptly. */
  shutdownSignal?: AbortSignal;
}
