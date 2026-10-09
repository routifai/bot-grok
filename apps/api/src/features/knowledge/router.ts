import { engineComputerClient, requireEngine } from "../../engine-client.js";
import type { RouterContext } from "../../routers/context.js";
import {
  engineKnowledgePageThumbnail,
  engineKnowledgeReindex,
  engineKnowledgeSearch,
  engineKnowledgeStatus,
} from "./service.js";

const knowledgeEngine = (actor: Parameters<typeof engineComputerClient>[0]) =>
  requireEngine(engineComputerClient(actor), "File search");

/** `knowledge.*`: the index state of the person's files, search, and page thumbnails; thin relays
 * to the engine through ./service.ts. */
export function knowledgeRouter(c: RouterContext) {
  const { museOnly, deps } = c;
  return {
    knowledge: {
      status: museOnly.knowledge.status.handler(({ context }) =>
        engineKnowledgeStatus(deps, knowledgeEngine(context.actor), context.actor),
      ),
      search: museOnly.knowledge.search.handler(({ context, input }) =>
        engineKnowledgeSearch(deps, knowledgeEngine(context.actor), context.actor, input),
      ),
      pageThumbnail: museOnly.knowledge.pageThumbnail.handler(({ context, input }) =>
        engineKnowledgePageThumbnail(deps, knowledgeEngine(context.actor), context.actor, input),
      ),
      reindex: museOnly.knowledge.reindex.handler(({ context }) =>
        engineKnowledgeReindex(deps, knowledgeEngine(context.actor), context.actor),
      ),
    },
  };
}
