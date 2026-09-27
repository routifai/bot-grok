import { waitForModelOAuthCompletion } from "@aiden/core";
import { rpc } from "./rpc";

export type { ModelCatalogEntry, ModelCredential, ModelOAuthBegin } from "@aiden/contracts";
export { cancelModelOAuthAttempt, finishModelOAuthAttempt } from "@aiden/core";

export async function waitForModelOAuth(loginId: string, signal?: AbortSignal) {
  return waitForModelOAuthCompletion(() => rpc.models.completeOAuth({ loginId }, { signal }), {
    signal,
  });
}
