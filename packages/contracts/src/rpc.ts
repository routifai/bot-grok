import { accountContract } from "./rpc/account.js";
import { activityContract } from "./rpc/activity.js";
import { engineAdminContract } from "./rpc/admin.js";
import { agentSecretsContract } from "./rpc/agent-secrets.js";
import { approvalsContract } from "./rpc/approvals.js";
import { appsContract } from "./rpc/apps.js";
import { artifactsContract } from "./rpc/artifacts.js";
import { botsContract } from "./rpc/bots.js";
import { computerContract } from "./rpc/computer.js";
import { dailyNotesContract } from "./rpc/daily-notes.js";
import { decksContract } from "./rpc/decks.js";
import { feedContract } from "./rpc/feed.js";
import { goalsContract } from "./rpc/goals.js";
import { ideasContract } from "./rpc/ideas.js";
import { integrationsContract } from "./rpc/integrations.js";
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
  ...botsContract,
  ...computerContract,
  ...dailyNotesContract,
  ...decksContract,
  ...engineAdminContract,
  ...engineModelsContract,
  ...feedContract,
  ...goalsContract,
  ...ideasContract,
  ...integrationsContract,
  ...memoryContract,
  ...messagingContract,
  ...modelsContract,
  ...museContract,
  ...scheduledContract,
  ...scratchpadContract,
  ...sheetsContract,
  ...sideChatsContract,
  ...skillsContract,
  ...threadsContract,
  ...vaultContract,
};

export type AppContract = typeof appContract;
