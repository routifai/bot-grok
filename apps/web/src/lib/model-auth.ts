import { waitForModelOAuthCompletion } from "@superchat/core";
import { rpc } from "./rpc";

export type { ModelCatalogEntry, ModelCredential, ModelOAuthBegin } from "@superchat/contracts";
export { cancelModelOAuthAttempt, finishModelOAuthAttempt } from "@superchat/core";

export async function waitForModelOAuth(loginId: string, signal?: AbortSignal) {
  return waitForModelOAuthCompletion(() => rpc.models.completeOAuth({ loginId }, { signal }), {
    signal,
  });
}
