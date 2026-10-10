import { accountContract } from "./rpc/account.js";
import { activityContract } from "./rpc/activity.js";
import { engineAdminContract, signupsContract } from "./rpc/admin.js";
import { agentSecretsContract } from "./rpc/agent-secrets.js";
import { approvalsContract } from "./rpc/approvals.js";
import { appsContract } from "./rpc/apps.js";
import { artifactsContract } from "./rpc/artifacts.js";
import { automationsContract } from "./rpc/automations.js";
import { botsContract } from "./rpc/bots.js";
import { chartsContract } from "./rpc/charts.js";
import { computerContract } from "./rpc/computer.js";
import { dailyNotesContract } from "./rpc/daily-notes.js";
import { decksContract } from "./rpc/decks.js";
import { integrationsContract } from "./rpc/integrations.js";
import { knowledgeContract } from "./rpc/knowledge.js";
import { modelsContract } from "./rpc/local-models.js";
import { memoryContract } from "./rpc/memory.js";
import { messagingContract } from "./rpc/messaging.js";
import { engineModelsContract } from "./rpc/models.js";
import { museContract } from "./rpc/muse.js";
import { scheduledContract } from "./rpc/scheduled.js";
import { scratchpadContract } from "./rpc/scratchpad.js";
import { sheetsContract } from "./rpc/sheets.js";
import { sideChatsContract } from "./rpc/side-chats.js";
import { skillsContract } from "./rpc/skills.js";
import { threadsContract } from "./rpc/threads.js";
import { vaultContract } from "./rpc/vault.js";

export const appContract = {
  ...accountContract,
  ...activityContract,
  ...agentSecretsContract,
  ...appsContract,
  ...approvalsContract,
  ...artifactsContract,
  ...automationsContract,
  ...botsContract,
  ...chartsContract,
  ...computerContract,
  ...dailyNotesContract,
  ...decksContract,
  ...engineAdminContract,
  ...engineModelsContract,
  ...integrationsContract,
  ...knowledgeContract,
  ...memoryContract,
  ...messagingContract,
  ...modelsContract,
  ...museContract,
  ...scheduledContract,
  ...scratchpadContract,
  ...sheetsContract,
  ...sideChatsContract,
  ...signupsContract,
  ...skillsContract,
  ...threadsContract,
  ...vaultContract,
};

export type AppContract = typeof appContract;
