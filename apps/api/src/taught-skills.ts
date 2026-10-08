// "Teach a task" (docs/adr/0004-engine-owns-the-computer.md): the engine records what the person
// does on the Computer, drafts the skill from the recording and stores it versioned on its server.
// Nova only relays: it starts and stops the recording (with Take over), maps the engine's skill
// onto the Review sheet's contract, and keeps the draft card in the thread. No Nova skill rows.
import type { JobPublisher } from "@aiden/adapter-kit";
import { runContinueJob } from "@aiden/adapter-kit";
import {
  deleteOmnigentTaughtSkill,
  emitSkillDraftMessages,
  getOmnigentSkillKeyframe,
  getOmnigentTaughtSkill,
  listOmnigentTaughtSkills,
  type OmnigentClientConfig,
  type OmnigentSkillDoc,
  type OmnigentTaughtSkill,
  putOmnigentTaughtSkillDoc,
  renderOmnigentTaughtSkill,
  saveOmnigentTaughtSkill,
  startOmnigentRecording,
  stopOmnigentRecording,
} from "@aiden/adapters";
import type { Actor, MessageBlock, SkillDraft, TaughtSkill } from "@aiden/contracts";
import { ACTIVE_RUN_STATUSES, buildPlaybookFromRecording, type SkillPlaybook } from "@aiden/core";
import { ENGINE_COMPUTER_ID } from "@aiden/core/node/screen-capability";
import { IsolationError, type PrismaClient, type ThreadEvents } from "@aiden/db";
import { ORPCError } from "@orpc/server";
import {
  engineComputerClient,
  engineComputerRelease,
  engineComputerTakeover,
  engineSessionOf,
} from "./engine-computer.js";

export interface TaughtSkillsDeps {
  prisma: PrismaClient;
  events: ThreadEvents;
  jobs: JobPublisher;
}

const DEFAULT_FAILURE =
  "If a step fails or the expected screen is not visible, stop and ask the user before retrying.";
const DEFAULT_APPROVAL =
  "Do not send messages, spend money, publish content, or delete data without explicit user approval.";

function engineClient(actor: Actor): OmnigentClientConfig {
  const client = engineComputerClient(actor);
  if (!client) throw new ORPCError("BAD_REQUEST", { message: "Teaching needs the engine" });
  return client;
}

/** The old playbook shape, derived from the draft for the thread card and "Add to routine". */
function playbookOf(goal: string, doc: OmnigentSkillDoc | null): SkillPlaybook {
  if (!doc) return buildPlaybookFromRecording(goal, []);
  const approvals = doc.steps.filter((step) => step.approval).map((step) => step.intent);
  return {
    whenToUse: [doc.goal || goal, ...doc.preconditions].join(" "),
    inputs: doc.inputs.map((input) => `${input.label}: ${input.default}`),
    steps: doc.steps.map((step) => step.intent),
    howToCheck: doc.steps
      .map((step) => step.check)
      .filter(Boolean)
      .join(" "),
    whatToReturn: doc.returns,
    approvalBoundaries: approvals.length
      ? `Ask before: ${approvals.join("; ")}. ${DEFAULT_APPROVAL}`
      : DEFAULT_APPROVAL,
    failureHandling: DEFAULT_FAILURE,
  };
}

function draftOf(doc: OmnigentSkillDoc | null): SkillDraft | null {
  if (!doc) return null;
  return {
    preconditions: doc.preconditions,
    inputs: doc.inputs,
    steps: doc.steps,
    returns: doc.returns,
  };
}

function iso(epochSeconds: number | null): string | null {
  return epochSeconds == null ? null : new Date(epochSeconds * 1000).toISOString();
}

function mapSkill(
  botId: string,
  skill: OmnigentTaughtSkill,
  keyframes?: Record<string, string>,
): TaughtSkill {
  return {
    id: skill.id,
    botId,
    name: skill.name,
    goal: skill.goal,
    status: skill.status,
    playbook: playbookOf(skill.goal, skill.doc),
    draft: draftOf(skill.doc),
    ...(keyframes ? { keyframes } : {}),
    recording: {
      events: [],
      snapshots: [],
      controlLeaseId: skill.status === "recording" ? ENGINE_COMPUTER_ID : undefined,
    },
    startedAt: iso(skill.created_at),
    expiresAt: null,
    stoppedAt: iso(skill.stopped_at),
    createdAt: iso(skill.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(skill.updated_at ?? skill.created_at) ?? new Date(0).toISOString(),
  };
}

/** The Muse's active teaching session, if any; sends are held while the person is teaching. */
export async function assertTeachingSendAllowed(
  prisma: PrismaClient,
  actor: Actor,
  botId: string,
): Promise<void> {
  const client = engineComputerClient(actor);
  if (!client) return;
  const recording = await (async () => {
    try {
      const { email, sessionId } = await engineSessionOf({ prisma }, client, actor, botId);
      if (!sessionId) return false;
      const skills = await listOmnigentTaughtSkills(client, email, sessionId);
      return skills.some((skill) => skill.status === "recording");
    } catch {
      // The send itself needs the engine and fails clearly there; never block on this check.
      return false;
    }
  })();
  if (recording) throw new ORPCError("CONFLICT", { message: "Stop teaching first" });
}

export function createTaughtSkillsService(deps: TaughtSkillsDeps) {
  /** The engine skill with the Muse it belongs to, checked against the actor. */
  async function owned(actor: Actor, skillId: string) {
    const client = engineClient(actor);
    const user = await deps.prisma.user.findUnique({
      where: { id: actor.userId },
      select: { email: true },
    });
    if (!user) throw new IsolationError();
    const skill = await getOmnigentTaughtSkill(client, user.email, skillId).catch((error) => {
      // A draft card from before teaching moved to the engine carries a non-engine id.
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "invalid_input" || code === "not_found") {
        throw new ORPCError("NOT_FOUND", { message: "Skill not found" });
      }
      throw error;
    });
    const link = await deps.prisma.omnigentSession.findFirst({
      where: {
        omnigentSessionId: skill.parent_session_id,
        bot: { spaceId: actor.spaceId, userId: actor.userId },
      },
      select: { botId: true },
    });
    if (!link) throw new IsolationError();
    return { client, email: user.email, skill, botId: link.botId };
  }

  async function keyframesOf(
    client: OmnigentClientConfig,
    email: string,
    skill: OmnigentTaughtSkill,
  ): Promise<Record<string, string>> {
    const names = [
      ...new Set((skill.doc?.steps ?? []).flatMap((s) => (s.keyframe ? [s.keyframe] : []))),
    ];
    const frames = await Promise.all(
      names.map(async (name) => [
        name,
        await getOmnigentSkillKeyframe(client, email, skill.id, name),
      ]),
    );
    return Object.fromEntries(
      frames.filter((entry): entry is [string, string] => entry[1] !== null),
    );
  }

  async function updateSkillDraftMessage(botId: string, skill: OmnigentTaughtSkill) {
    const bot = await deps.prisma.bot.findUnique({
      where: { id: botId },
      include: { thread: true },
    });
    if (!bot?.thread) return;
    const messages = await deps.prisma.message.findMany({
      where: { threadId: bot.thread.id, role: "bot" },
      orderBy: { seq: "desc" },
      take: 100,
    });
    for (const message of messages) {
      const blocks = message.blocks as MessageBlock[];
      if (!Array.isArray(blocks)) continue;
      const index = blocks.findIndex((b) => b.kind === "skill_draft" && b.skillId === skill.id);
      const existing = blocks[index];
      if (existing?.kind !== "skill_draft") continue;
      const next: MessageBlock[] = [...blocks];
      next[index] = {
        ...existing,
        name: skill.name || existing.name,
        playbook: playbookOf(skill.goal, skill.doc),
        status: skill.status === "saved" ? "saved" : "draft",
      };
      await deps.prisma.message.update({
        where: { id: message.id },
        data: { blocks: next as never },
      });
      await deps.events.append({
        spaceId: bot.spaceId,
        threadId: bot.thread.id,
        botId,
        type: "thread.message.updated",
        payload: { messageId: message.id, role: "bot", blocks: next },
      });
      return;
    }
  }

  async function releaseControl(actor: Actor, client: OmnigentClientConfig, botId: string) {
    await engineComputerRelease(deps, client, actor, botId).catch(() => undefined);
  }

  return {
    async list(actor: Actor, botId: string): Promise<TaughtSkill[]> {
      const client = engineClient(actor);
      const { email, sessionId } = await engineSessionOf(deps, client, actor, botId);
      if (!sessionId) return [];
      const skills = await listOmnigentTaughtSkills(client, email, sessionId);
      return skills.map((skill) => mapSkill(botId, skill));
    },

    async get(actor: Actor, skillId: string): Promise<TaughtSkill> {
      const { client, email, skill, botId } = await owned(actor, skillId);
      return mapSkill(botId, skill, await keyframesOf(client, email, skill));
    },

    async start(actor: Actor, botId: string, goal: string): Promise<TaughtSkill> {
      const client = engineClient(actor);
      const bot = await deps.prisma.bot.findFirst({
        where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
        include: { thread: true },
      });
      if (!bot) throw new IsolationError();
      const { email, sessionId } = await engineSessionOf(deps, client, actor, botId);
      if (!sessionId) {
        throw new ORPCError("BAD_REQUEST", { message: "Computer must be running to teach" });
      }
      const activeRuns = await deps.prisma.run.findMany({
        where: { botId, status: { in: [...ACTIVE_RUN_STATUSES] } },
        select: { id: true },
      });
      await deps.prisma.run.updateMany({
        where: { botId, status: { in: [...ACTIVE_RUN_STATUSES] } },
        data: { status: "cancelled", completedAt: new Date() },
      });
      await deps.prisma.event.deleteMany({
        where: { type: "thread.progress", runId: { in: activeRuns.map((run) => run.id) } },
      });
      // The person holds the Computer while teaching (ADR 0004), then the engine records it.
      await engineComputerTakeover(deps, client, actor, botId);
      let started: { skill_id: string };
      try {
        started = await startOmnigentRecording(client, email, sessionId, goal);
      } catch (error) {
        await releaseControl(actor, client, botId);
        throw error;
      }
      if (bot.thread) {
        await deps.events.append({
          spaceId: actor.spaceId,
          threadId: bot.thread.id,
          botId,
          type: "skill.teaching.started",
          payload: { skillId: started.skill_id, goal },
        });
      }
      return mapSkill(botId, await getOmnigentTaughtSkill(client, email, started.skill_id));
    },

    // Capture happens in the Computer's browser; the web overlay's pointer events and snapshots
    // are not needed, so these keep the contract and change nothing.
    async appendEvent(actor: Actor, skillId: string, _event?: unknown): Promise<TaughtSkill> {
      return this.get(actor, skillId);
    },

    async snapshot(actor: Actor, skillId: string): Promise<TaughtSkill> {
      return this.get(actor, skillId);
    },

    async recordInput(
      _actor?: Actor,
      _botId?: string,
      _input?: unknown,
    ): Promise<"recorded" | "idle" | "stale"> {
      return "idle";
    },

    async stop(actor: Actor, skillId: string): Promise<TaughtSkill> {
      const { client, email, skill, botId } = await owned(actor, skillId);
      if (skill.status !== "recording") {
        await releaseControl(actor, client, botId);
        return mapSkill(botId, skill);
      }
      const { sessionId } = await engineSessionOf(deps, client, actor, botId);
      if (!sessionId) throw new IsolationError();
      try {
        await stopOmnigentRecording(client, email, sessionId);
      } finally {
        await releaseControl(actor, client, botId);
      }
      const stopped = await getOmnigentTaughtSkill(client, email, skillId);
      const bot = await deps.prisma.bot.findUnique({
        where: { id: botId },
        include: { thread: true },
      });
      if (bot?.thread) {
        // The card appears now; the Review sheet fills in as the teacher finishes the draft.
        await emitSkillDraftMessages(
          deps,
          actor,
          {
            id: stopped.id,
            name: stopped.goal.slice(0, 80),
            goal: stopped.goal,
            status: "draft",
            playbook: playbookOf(stopped.goal, null),
          },
          { id: botId, thread: bot.thread },
        );
        await deps.events.append({
          spaceId: actor.spaceId,
          threadId: bot.thread.id,
          botId,
          type: "skill.teaching.stopped",
          payload: { skillId },
        });
      }
      return mapSkill(botId, stopped);
    },

    async updateDraft(
      actor: Actor,
      skillId: string,
      input: { name?: string; draft?: SkillDraft },
    ): Promise<TaughtSkill> {
      const { client, email, skill, botId } = await owned(actor, skillId);
      if (!skill.doc) {
        throw new ORPCError("BAD_REQUEST", { message: "Skill is not editable yet" });
      }
      const doc: OmnigentSkillDoc = {
        ...skill.doc,
        ...(input.draft ?? {}),
        name: input.name?.trim() || skill.doc.name,
      };
      const saved = await putOmnigentTaughtSkillDoc(client, email, skillId, doc);
      await updateSkillDraftMessage(botId, saved);
      return mapSkill(botId, saved, await keyframesOf(client, email, saved));
    },

    async save(actor: Actor, skillId: string, name?: string): Promise<TaughtSkill> {
      const { client, email, skill, botId } = await owned(actor, skillId);
      if (!skill.doc || (skill.status !== "draft" && skill.status !== "saved")) {
        throw new ORPCError("BAD_REQUEST", { message: "Finish recording before saving" });
      }
      if (name?.trim() && name.trim() !== skill.doc.name) {
        await putOmnigentTaughtSkillDoc(client, email, skillId, {
          ...skill.doc,
          name: name.trim(),
        });
      }
      const saved = await saveOmnigentTaughtSkill(client, email, skillId);
      await updateSkillDraftMessage(botId, saved);
      const bot = await deps.prisma.bot.findUnique({
        where: { id: botId },
        include: { thread: true },
      });
      if (bot?.thread) {
        await deps.events.append({
          spaceId: actor.spaceId,
          threadId: bot.thread.id,
          botId,
          type: "skill.saved",
          payload: { skillId, name: saved.name },
        });
      }
      return mapSkill(botId, saved, await keyframesOf(client, email, saved));
    },

    /** Runs the skill as an ordinary turn: the rendered skill text goes to the Muse as a message. */
    async testRun(
      actor: Actor,
      skillId: string,
      options: { prompt?: string; inputs?: Record<string, string> } = {},
    ): Promise<{ runId: string }> {
      const { client, email, skill, botId } = await owned(actor, skillId);
      if (skill.status !== "saved" && skill.status !== "draft") {
        throw new ORPCError("BAD_REQUEST", { message: "Skill must be saved or drafted first" });
      }
      const bot = await deps.prisma.bot.findUnique({
        where: { id: botId },
        include: { thread: true },
      });
      if (!bot?.thread) throw new IsolationError();
      let prompt = options.prompt;
      if (!prompt) {
        const rendered = await renderOmnigentTaughtSkill(client, email, skillId, options.inputs);
        prompt = [
          `Test run of my skill "${rendered.name}". This is safe: do not send, spend, delete or publish anything, and start from a clean screen so you do not mistake what is already shown for a result.`,
          rendered.text,
        ].join("\n\n");
      }
      const task = await deps.prisma.task.create({
        data: {
          spaceId: actor.spaceId,
          botId,
          threadId: bot.thread.id,
          userId: actor.userId,
          prompt,
          status: "queued",
        },
      });
      const run = await deps.prisma.run.create({
        data: {
          spaceId: actor.spaceId,
          botId,
          threadId: bot.thread.id,
          taskId: task.id,
          userId: actor.userId,
          status: "queued",
          trigger: "skill",
        },
      });
      await deps.jobs.enqueue(runContinueJob(run.id));
      return { runId: run.id };
    },

    async remove(actor: Actor, skillId: string): Promise<{ ok: true }> {
      const { client, email, skill, botId } = await owned(actor, skillId);
      if (skill.status === "recording") {
        const { sessionId } = await engineSessionOf(deps, client, actor, botId);
        if (sessionId) await stopOmnigentRecording(client, email, sessionId).catch(() => undefined);
        await releaseControl(actor, client, botId);
      }
      await deleteOmnigentTaughtSkill(client, email, skillId);
      return { ok: true as const };
    },
  };
}
