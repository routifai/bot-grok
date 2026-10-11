import { accountRouter } from "./account";
import { activityRouter } from "./activity";
import { approvalsRouter } from "./approvals";
import { appsRouter } from "./apps";
import { artifactsRouter } from "./artifacts";
import { automationsRouter } from "./automations";
import { chartsRouter } from "./charts";
import { chatsRouter } from "./chats";
import { computerRouter } from "./computer";
import { os } from "./context";
import { dailyNotesRouter } from "./daily-notes";
import { decksRouter } from "./decks";
import { filesRouter } from "./files";
import { knowledgeRouter } from "./knowledge";
import { memoryRouter } from "./memory";
import { engineModelsRouter } from "./models";
import { museRouter } from "./muse";
import { searchRouter } from "./search";
import { sheetsRouter } from "./sheets";
import { vaultRouter } from "./vault";

/** Every procedure the app calls, answered by the engine's REST API from this page. */
export const router = os.router({
  ...accountRouter,
  ...activityRouter,
  ...appsRouter,
  ...approvalsRouter,
  ...artifactsRouter,
  ...automationsRouter,
  ...chartsRouter,
  ...chatsRouter,
  ...computerRouter,
  ...dailyNotesRouter,
  ...decksRouter,
  ...engineModelsRouter,
  ...filesRouter,
  ...knowledgeRouter,
  ...memoryRouter,
  ...museRouter,
  ...searchRouter,
  ...sheetsRouter,
  ...vaultRouter,
});
