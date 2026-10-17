import { accountContract } from "./rpc/account.js";
import { activityContract } from "./rpc/activity.js";
import { approvalsContract } from "./rpc/approvals.js";
import { appsContract } from "./rpc/apps.js";
import { artifactsContract } from "./rpc/artifacts.js";
import { automationsContract } from "./rpc/automations.js";
import { botsContract } from "./rpc/bots.js";
import { chatsContract } from "./rpc/chats.js";
import { computerContract } from "./rpc/computer.js";
import { dailyNotesContract } from "./rpc/daily-notes.js";
import { decksContract } from "./rpc/decks.js";
import { knowledgeContract } from "./rpc/knowledge.js";
import { liveContract } from "./rpc/live.js";
import { memoryContract } from "./rpc/memory.js";
import { engineModelsContract } from "./rpc/models.js";
import { museContract } from "./rpc/muse.js";
import { sheetsContract } from "./rpc/sheets.js";
import { vaultContract } from "./rpc/vault.js";

export const appContract = {
  ...accountContract,
  ...activityContract,
  ...appsContract,
  ...approvalsContract,
  ...artifactsContract,
  ...automationsContract,
  ...botsContract,
  ...chatsContract,
  ...computerContract,
  ...dailyNotesContract,
  ...decksContract,
  ...engineModelsContract,
  ...knowledgeContract,
  ...liveContract,
  ...memoryContract,
  ...museContract,
  ...sheetsContract,
  ...vaultContract,
};

export type AppContract = typeof appContract;
