import { activityRouter } from "./features/activity/router.js";
import { engineAdminRouter } from "./features/admin/router.js";
import { approvalsRouter } from "./features/approvals/router.js";
import { appsRouter } from "./features/apps/router.js";
import { artifactsRouter } from "./features/artifacts/router.js";
import { filesRouter } from "./features/computer/files-router.js";
import { computerRouter } from "./features/computer/router.js";
import { dailyNotesRouter } from "./features/daily-notes/router.js";
import { decksRouter } from "./features/decks/router.js";
import { feedRouter } from "./features/feed/router.js";
import { goalsRouter } from "./features/goals/router.js";
import { ideasRouter } from "./features/ideas/router.js";
import { memoryRouter } from "./features/memory/router.js";
import { engineModelsRouter } from "./features/models/router.js";
import { sheetsRouter } from "./features/sheets/router.js";
import { sideChatsRouter } from "./features/side-chats/router.js";
import { skillsRouter } from "./features/skills/router.js";
import { vaultRouter } from "./features/vault/router.js";
import { accountRouter } from "./routers/account.js";
import { agentSecretsRouter } from "./routers/agent-secrets.js";
import { botsRouter } from "./routers/bots.js";
import { connectionsRouter } from "./routers/connections.js";
import type { RouterDeps } from "./routers/context.js";
import { createRouterContext } from "./routers/context.js";
import { integrationsRouter } from "./routers/integrations.js";
import { mcpRouter } from "./routers/mcp.js";
import { messagingRouter } from "./routers/messaging.js";
import { modelsRouter } from "./routers/models.js";
import { museRouter } from "./routers/muse.js";
import { scheduledRouter } from "./routers/scheduled.js";
import { scratchpadRouter } from "./routers/scratchpad.js";
import { threadsRouter } from "./routers/threads.js";

export { assertMuseSingleBotAllowed } from "./routers/bots.js";
export type { RouterDeps } from "./routers/context.js";

export function createRouter(deps: RouterDeps) {
  const c = createRouterContext(deps);
  return c.os.router({
    ...accountRouter(c),
    ...activityRouter(c),
    ...agentSecretsRouter(c),
    ...appsRouter(c),
    ...approvalsRouter(c),
    ...artifactsRouter(c),
    ...botsRouter(c),
    ...computerRouter(c),
    ...dailyNotesRouter(c),
    ...decksRouter(c),
    ...engineAdminRouter(c),
    ...engineModelsRouter(c),
    ...connectionsRouter(c),
    ...feedRouter(c),
    ...filesRouter(c),
    ...goalsRouter(c),
    ...ideasRouter(c),
    ...integrationsRouter(c),
    ...mcpRouter(c),
    ...memoryRouter(c),
    ...messagingRouter(c),
    ...modelsRouter(c),
    ...museRouter(c),
    ...scheduledRouter(c),
    ...scratchpadRouter(c),
    ...sideChatsRouter(c),
    ...sheetsRouter(c),
    ...skillsRouter(c),
    ...threadsRouter(c),
    ...vaultRouter(c),
  });
}
