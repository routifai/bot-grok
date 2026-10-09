import { accountContract } from "./rpc/account.js";
import { approvalsContract } from "./rpc/approvals.js";
import { artifactsContract } from "./rpc/artifacts.js";
import { botsContract } from "./rpc/bots.js";
import { chatsContract } from "./rpc/chats.js";
import { computerContract } from "./rpc/computer.js";
import { engineModelsContract } from "./rpc/engine-models.js";
import { feedContract } from "./rpc/feed.js";
import { goalsContract } from "./rpc/goals.js";
import { integrationsContract } from "./rpc/integrations.js";
import { memoryContract } from "./rpc/memory.js";
import { messagingContract } from "./rpc/messaging.js";
import { modelsContract } from "./rpc/models.js";
import { scheduledContract } from "./rpc/scheduled.js";
import { skillsContract } from "./rpc/skills.js";
import { threadsContract } from "./rpc/threads.js";

export const appContract = {
  ...accountContract,
  ...approvalsContract,
  ...artifactsContract,
  ...botsContract,
  ...chatsContract,
  ...computerContract,
  ...engineModelsContract,
  ...feedContract,
  ...goalsContract,
  ...integrationsContract,
  ...memoryContract,
  ...messagingContract,
  ...modelsContract,
  ...scheduledContract,
  ...skillsContract,
  ...threadsContract,
};

export type AppContract = typeof appContract;
