// Requeuing a run whose computer is switching or busy: releasing the lease, choosing
// queued vs. waiting_takeover, and scheduling the retry with backoff.
import { runContinueJob } from "@aiden/adapter-kit";
import type { TakeoverResumeCheckpoint } from "../takeover-resume.js";
import { TAKEOVER_RESUME_CHECKPOINTS } from "../takeover-resume.js";
import { computerRetryDelay } from "./run-tools.js";
import type { ExecutorDeps } from "./types.js";

function computerRunRequeueData(
  resumeCheckpoint: TakeoverResumeCheckpoint | null,
  error: string | null = null,
  heldForTakeover = false,
) {
  return {
    status:
      heldForTakeover && !resumeCheckpoint ? ("waiting_takeover" as const) : ("queued" as const),
    error,
    leaseOwner: null,
    leaseExpiresAt: null,
    checkpoint: resumeCheckpoint,
  };
}

export async function writeComputerRunRequeue(
  deps: ExecutorDeps,
  runId: string,
  workerId: string,
  fence: number,
  resumeCheckpoint: TakeoverResumeCheckpoint | null,
  heldForTakeover = false,
  error: string | null = null,
): Promise<boolean> {
  const whereLease = {
    id: runId,
    status: "running" as const,
    leaseOwner: workerId,
    leaseFence: fence,
  };
  const releasedHold = {
    status: "queued" as const,
    error,
    leaseOwner: null,
    leaseExpiresAt: null,
  };
  const preserve = await deps.prisma.run.updateMany({
    where: {
      ...whereLease,
      checkpoint: { in: [...TAKEOVER_RESUME_CHECKPOINTS] },
    },
    data: releasedHold,
  });
  if (preserve.count === 1) return true;
  const planned = await deps.prisma.run.updateMany({
    where: { ...whereLease, checkpoint: null },
    data: computerRunRequeueData(resumeCheckpoint, error, heldForTakeover),
  });
  if (planned.count === 1) return true;
  const retried = await deps.prisma.run.updateMany({
    where: {
      ...whereLease,
      checkpoint: { in: [...TAKEOVER_RESUME_CHECKPOINTS] },
    },
    data: releasedHold,
  });
  return retried.count === 1;
}

export async function requeueComputerRun(
  deps: ExecutorDeps,
  runId: string,
  workerId: string,
  fence: number,
  resumeCheckpoint: TakeoverResumeCheckpoint | null,
  heldForTakeover = false,
): Promise<void> {
  const released = await writeComputerRunRequeue(
    deps,
    runId,
    workerId,
    fence,
    resumeCheckpoint,
    heldForTakeover,
  );
  if (!released) return;
  await deps.jobs.enqueue({
    ...runContinueJob(runId),
    availableAt: new Date(Date.now() + computerRetryDelay(fence)),
  });
}
