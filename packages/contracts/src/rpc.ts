import { accountContract } from "./rpc/account.js";
import { activityContract } from "./rpc/activity.js";
import { approvalsContract } from "./rpc/approvals.js";
import { appsContract } from "./rpc/apps.js";
import { artifactsContract } from "./rpc/artifacts.js";
import { automationsContract } from "./rpc/automations.js";
import { botsContract } from "./rpc/bots.js";
import { chartsContract } from "./rpc/charts.js";
import { computerContract } from "./rpc/computer.js";
import { dailyNotesContract } from "./rpc/daily-notes.js";
import { decksContract } from "./rpc/decks.js";
import { knowledgeContract } from "./rpc/knowledge.js";
import { liveContract } from "./rpc/live.js";
import { memoryContract } from "./rpc/memory.js";
import { engineModelsContract } from "./rpc/models.js";
import { museContract } from "./rpc/muse.js";
import { sheetsContract } from "./rpc/sheets.js";
import { sideChatsContract } from "./rpc/side-chats.js";
import { vaultContract } from "./rpc/vault.js";

export const appContract = {
  ...accountContract,
  ...activityContract,
  ...appsContract,
  ...approvalsContract,
  ...artifactsContract,
  ...automationsContract,
  ...botsContract,
  ...chartsContract,
  ...computerContract,
  ...dailyNotesContract,
  ...decksContract,
  ...engineModelsContract,
  ...knowledgeContract,
  ...liveContract,
  ...memoryContract,
  ...museContract,
  ...sheetsContract,
  ...sideChatsContract,
  ...vaultContract,
};

export type AppContract = typeof appContract;
