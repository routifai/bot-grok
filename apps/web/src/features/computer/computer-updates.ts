import { createComputerUpdates } from "@nova/core";
import { rpc } from "../../lib/rpc";
export const computerUpdates = createComputerUpdates({
  list: () => rpc.computer.updates(),
  start: (botId, action) => rpc.computer[action]({ botId }),
  releaseInterrupted: (id) => rpc.computer.releaseInterrupted({ id, workersStopped: true }),
  dismiss: (id) => rpc.computer.dismissUpdate({ id }),
});
