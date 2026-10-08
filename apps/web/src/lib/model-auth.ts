import { waitForModelOAuthCompletion } from "@nova/core";
import { rpc } from "./rpc";

export type { ModelCatalogEntry, ModelCredential, ModelOAuthBegin } from "@nova/contracts";
export { cancelModelOAuthAttempt, finishModelOAuthAttempt } from "@nova/core";

export async function waitForModelOAuth(loginId: string, signal?: AbortSignal) {
  return waitForModelOAuthCompletion(() => rpc.models.completeOAuth({ loginId }, { signal }), {
    signal,
  });
}
