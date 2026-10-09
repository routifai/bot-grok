import { engineAdminRouter } from "./features/admin/router.js";
import { appsRouter } from "./features/apps/router.js";
import { engineModelsRouter } from "./features/models/router.js";
import { sheetsRouter } from "./features/sheets/router.js";
import { accountRouter } from "./routers/account.js";
import { approvalsRouter } from "./routers/approvals.js";
import { artifactsRouter } from "./routers/artifacts.js";
import { botsRouter } from "./routers/bots.js";
import { computerRouter } from "./routers/computer.js";
import { connectionsRouter } from "./routers/connections.js";
import type { RouterDeps } from "./routers/context.js";
import { createRouterContext } from "./routers/context.js";
import { feedRouter } from "./routers/feed.js";
import { goalsRouter } from "./routers/goals.js";
import { integrationsRouter } from "./routers/integrations.js";
import { mcpRouter } from "./routers/mcp.js";
import { memoryRouter } from "./routers/memory.js";
import { messagingRouter } from "./routers/messaging.js";
import { modelsRouter } from "./routers/models.js";
import { scheduledRouter } from "./routers/scheduled.js";
import { sideChatsRouter } from "./routers/side-chats.js";
import { skillsRouter } from "./routers/skills.js";
import { threadsRouter } from "./routers/threads.js";

export { assertMuseSingleBotAllowed } from "./routers/bots.js";
export type { RouterDeps } from "./routers/context.js";

export function createRouter(deps: RouterDeps) {
  const c = createRouterContext(deps);
  return c.os.router({
    ...accountRouter(c),
    ...appsRouter(c),
    ...approvalsRouter(c),
    ...artifactsRouter(c),
    ...botsRouter(c),
    ...computerRouter(c),
    ...engineAdminRouter(c),
    ...engineModelsRouter(c),
    ...connectionsRouter(c),
    ...feedRouter(c),
    ...goalsRouter(c),
    ...integrationsRouter(c),
    ...mcpRouter(c),
    ...memoryRouter(c),
    ...messagingRouter(c),
    ...modelsRouter(c),
    ...scheduledRouter(c),
    ...sideChatsRouter(c),
    ...sheetsRouter(c),
    ...skillsRouter(c),
    ...threadsRouter(c),
  });
}
