import { getOmnigentComputer } from "@superchat/adapters/omnigent/browser";
import type { ComputerStatus } from "@superchat/contracts";
import { engineClient, museSessionId, NO_EMAIL } from "./client";
import { os } from "./context";

const LAUNCH_STAGES = new Set(["provisioning", "cloning", "starting", "connecting", "failed"]);

/** Whether the engine's Computer is ready and how its launch is going. The page keeps no Computer
 * state: the engine owns it and is always on. */
async function computerStatus(botId: string): Promise<ComputerStatus> {
  const { ready, launch } = await getOmnigentComputer(
    engineClient(),
    NO_EMAIL,
    await museSessionId(),
  );
  // Running means the Conversation's runner is bound and connected.
  const status: ComputerStatus = {
    botId,
    state: ready ? "running" : "stopped",
    runnerReady: ready,
  };
  const stage = launch?.stage;
  return stage && stage !== "ready" && LAUNCH_STAGES.has(stage)
    ? { ...status, launch: { stage: stage as NonNullable<ComputerStatus["launch"]>["stage"] } }
    : status;
}

export const computerRouter = {
  computer: {
    status: os.computer.status.handler(({ input }) => computerStatus(input.botId)),
  },
};
