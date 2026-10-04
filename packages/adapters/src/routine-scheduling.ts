// Deferring a routine's next wakeup job when it is scheduled far enough in the future.
import type { JobPublisher } from "@aiden/adapter-kit";
import { routineWakeupJob } from "@aiden/adapter-kit";

export async function deferFutureRoutine(
  jobs: JobPublisher,
  routineId: string,
  scheduledAt: Date,
): Promise<boolean> {
  if (scheduledAt.getTime() <= Date.now() + 1_000) return false;
  await jobs.enqueue(routineWakeupJob(routineId, scheduledAt));
  return true;
}
