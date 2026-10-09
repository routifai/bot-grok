import { accountContract } from "./rpc/account.js";
import { activityContract } from "./rpc/activity.js";
import { engineAdminContract } from "./rpc/admin.js";
import { approvalsContract } from "./rpc/approvals.js";
import { appsContract } from "./rpc/apps.js";
import { artifactsContract } from "./rpc/artifacts.js";
import { botsContract } from "./rpc/bots.js";
import { chatsContract } from "./rpc/chats.js";
import { computerContract } from "./rpc/computer.js";
import { dailyNotesContract } from "./rpc/daily-notes.js";
import { feedContract } from "./rpc/feed.js";
import { goalsContract } from "./rpc/goals.js";
import { integrationsContract } from "./rpc/integrations.js";
import { modelsContract } from "./rpc/local-models.js";
import { memoryContract } from "./rpc/memory.js";
import { messagingContract } from "./rpc/messaging.js";
import { engineModelsContract } from "./rpc/models.js";
import { scheduledContract } from "./rpc/scheduled.js";
import { sheetsContract } from "./rpc/sheets.js";
import { skillsContract } from "./rpc/skills.js";
import { threadsContract } from "./rpc/threads.js";
import { vaultContract } from "./rpc/vault.js";

export const appContract = {
  ...accountContract,
  ...activityContract,
  ...appsContract,
  ...approvalsContract,
  ...artifactsContract,
  ...botsContract,
  ...chatsContract,
  ...computerContract,
  ...dailyNotesContract,
  ...engineAdminContract,
  ...engineModelsContract,
  ...feedContract,
  ...goalsContract,
  ...integrationsContract,
  ...memoryContract,
  ...messagingContract,
  ...modelsContract,
  ...scheduledContract,
  ...sheetsContract,
  ...skillsContract,
  ...threadsContract,
  ...vaultContract,
};

export type AppContract = typeof appContract;
