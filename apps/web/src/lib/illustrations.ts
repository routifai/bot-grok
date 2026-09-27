import type { IllustrationKey as ContractIllustrationKey } from "@aiden/contracts";
import { ILLUSTRATION_KEYS as CONTRACT_ILLUSTRATION_KEYS } from "@aiden/contracts";

// One source of truth for the Muse edition's bundled 3D illustrations (Microsoft Fluent
// Emoji, MIT; see NOTICE). The key list itself lives in @aiden/contracts so the backend
// (the Ideas refresh prompt/parser) and the web client agree on exactly the same set;
// this module just resolves a key to where its PNG is served from.

/** Every bundled illustration key, re-exported from @aiden/contracts (the source of truth). */
export const ILLUSTRATION_KEYS = CONTRACT_ILLUSTRATION_KEYS;
export type IllustrationKey = ContractIllustrationKey;

/** Static public path for a bundled illustration (apps/web/public/illustrations). */
export function illustrationUrl(key: IllustrationKey): string {
  return `/illustrations/${key}.png`;
}
