// Settings > Computer's choices: the agent bundle (harness) the Muse's Conversation runs on, and
// the runner it runs on. Both are the engine's own mechanisms: `PUT /v1/me/muse` switches the
// agent, and moving between the person's hosts is the engine web UI's switch-host pair
// (`moveOmnigentSessionToHost`). The managed Computer stays server-placed, as in the engine's UI.

import { ORPCError } from "@orpc/server";
import {
  getOmnigentHostHome,
  getOmnigentServerInfo,
  getOmnigentSession,
  listOmnigentAgents,
  listOmnigentHosts,
  moveOmnigentSessionToHost,
  OmnigentApiError,
  type OmnigentClientConfig,
  type OmnigentHost,
  omnigentErrorCopy,
  putOmnigentMuseAgent,
} from "@superchat/adapters";
import type { Actor, ComputerRunner, ComputerRuntime } from "@superchat/contracts";
import type { PrismaClient } from "@superchat/db";
import { resolveEngineComputer } from "../../engine-client.js";

type Deps = { prisma: PrismaClient };

/** The engine's agent bundles that are Superchat's (infra/omnigent/agents). */
const SUPERCHAT_AGENT = /^superchat-/;
/** The label a managed session's create records (engine `MANAGED_PROVIDER_LABEL_KEY`). */
const MANAGED_PROVIDER_LABEL = "omnigent.sandbox.provider";

export async function engineComputerRuntime(
  deps: Deps,
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string,
): Promise<ComputerRuntime> {
  const target = await resolveEngineComputer(deps, client, actor, botId);
  const { email, sessionId } = target;
  const [agents, hosts, info, snapshot, row] = await Promise.all([
    listOmnigentAgents(client, email),
    listOmnigentHosts(client, email).catch((): OmnigentHost[] => []),
    getOmnigentServerInfo(client, email).catch(() => ({
      accounts_enabled: false,
      login_url: null,
    })),
    sessionId ? getOmnigentSession(client, email, sessionId).catch(() => null) : null,
    deps.prisma.omnigentSession.findUnique({ where: { botId }, select: { agentName: true } }),
  ]);
  const busy = snapshot?.status === "running";
  const hostId = snapshot?.host_id ?? null;
  const current = hosts.find((host) => host.host_id === hostId);
  const recordedProvider = snapshot?.labels?.[MANAGED_PROVIDER_LABEL];
  const managed = Boolean(recordedProvider) || Boolean(current?.sandbox_provider);

  const runners: ComputerRunner[] = [];
  if (current?.sandbox_provider) {
    runners.push({
      hostId: current.host_id,
      name: current.name,
      kind: "computer",
      provider: current.sandbox_provider,
      online: current.status === "online",
      current: true,
      movable: false,
    });
  } else if (managed && recordedProvider) {
    // Its first start hasn't registered a host yet: the next message starts it.
    runners.push({
      hostId: null,
      name: recordedProvider,
      kind: "computer",
      provider: recordedProvider === "default" ? null : recordedProvider,
      online: false,
      current: true,
      movable: false,
    });
  }
  for (const host of hosts) {
    if (host.sandbox_provider) continue;
    const online = host.status === "online";
    const isCurrent = host.host_id === hostId;
    runners.push({
      hostId: host.host_id,
      name: host.name,
      kind: "host",
      provider: null,
      online,
      current: isCurrent,
      movable: Boolean(sessionId) && !managed && !busy && online && !isCurrent,
    });
  }

  const signsInHosts = Boolean(info.accounts_enabled || info.login_url);
  return {
    busy,
    agent: row?.agentName ?? null,
    agents: agents
      .filter((agent) => SUPERCHAT_AGENT.test(agent.name) && agent.builtin !== false)
      .map((agent) => ({ name: agent.name, harness: agent.harness ?? null })),
    runners,
    managed,
    connectCommand: signsInHosts
      ? `omni host --server ${client.baseUrl.replace(/\/+$/, "")}`
      : null,
  };
}

function engineRefusal(error: unknown, fallback: string): never {
  if (error instanceof OmnigentApiError) {
    if (error.code === "conflict") {
      throw new ORPCError("CONFLICT", { message: "Wait for the reply to finish." });
    }
    throw new ORPCError("BAD_REQUEST", { message: omnigentErrorCopy(error) ?? fallback });
  }
  throw error;
}

/** Runs the Muse's Conversation on `agent` (one of Superchat's bundles) from its next message. */
export async function setEngineComputerAgent(
  deps: Deps,
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string,
  agent: string,
): Promise<{ agent: string }> {
  const { email } = await resolveEngineComputer(deps, client, actor, botId);
  const agents = await listOmnigentAgents(client, email);
  if (!agents.some((known) => known.name === agent && SUPERCHAT_AGENT.test(known.name))) {
    throw new ORPCError("BAD_REQUEST", { message: "That harness isn't available." });
  }
  let muse: Awaited<ReturnType<typeof putOmnigentMuseAgent>>;
  try {
    muse = await putOmnigentMuseAgent(client, email, agent);
  } catch (error) {
    engineRefusal(error, "Couldn't switch the harness.");
  }
  // The row mirrors the engine's answer (the gateway rewrites it each turn); the model list and
  // the harness shown follow it now rather than after the next message.
  await deps.prisma.omnigentSession.updateMany({
    where: { botId },
    data: { agentName: muse.agent },
  });
  return { agent: muse.agent };
}

/** Moves the Muse's Conversation onto one of the person's own online hosts. */
export async function moveEngineComputerRunner(
  deps: Deps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { botId: string; hostId: string; workspace?: string },
): Promise<{ hostId: string }> {
  const target = await resolveEngineComputer(deps, client, actor, input.botId);
  if (!target.sessionId) {
    throw new ORPCError("BAD_REQUEST", { message: "Send a message first." });
  }
  const runtime = await engineComputerRuntime(deps, client, actor, input.botId);
  const runner = runtime.runners.find((r) => r.hostId === input.hostId && r.kind === "host");
  if (!runner) throw new ORPCError("NOT_FOUND", { message: "Host not found." });
  if (runtime.managed) {
    throw new ORPCError("BAD_REQUEST", {
      message: "A Conversation on the managed Computer stays there.",
    });
  }
  if (runtime.busy) throw new ORPCError("CONFLICT", { message: "Wait for the reply to finish." });
  if (!runner.movable) throw new ORPCError("CONFLICT", { message: "That host is offline." });
  let workspace = input.workspace?.trim() || null;
  try {
    workspace ??= await getOmnigentHostHome(client, target.email, input.hostId);
  } catch (error) {
    engineRefusal(error, "Couldn't reach that host.");
  }
  if (!workspace) throw new ORPCError("BAD_REQUEST", { message: "Choose a folder on that host." });
  try {
    await moveOmnigentSessionToHost(
      client,
      target.email,
      target.sessionId,
      input.hostId,
      workspace,
    );
  } catch (error) {
    engineRefusal(error, "Couldn't move there.");
  }
  return { hostId: input.hostId };
}
