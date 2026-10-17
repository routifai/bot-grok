import { useLingui } from "@lingui/react/macro";
import type { ThreadMessage } from "@superchat/contracts";
import { useMemo, useSyncExternalStore } from "react";
import { activityFeedFor } from "./useActivities";
import { answeredWhileWorking } from "./workStripState";

/** The ids of the replies given while earlier work went on (workStripState.ts `answeredWhileWorking`),
 * read from the shared Activity feed. */
export function useAnsweredWhileWorking(
  botId: string,
  messages: readonly ThreadMessage[],
  /** The transcript says a turn runs right now. */
  running = false,
): ReadonlySet<string> {
  const feed = activityFeedFor(botId);
  const { state } = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const activities = state.status === "ready" ? state.activities : undefined;
  return useMemo(
    () => answeredWhileWorking(messages, activities, running),
    [messages, activities, running],
  );
}

/** The quiet meta line under such a reply. The engine does not report a time to first word on a
 * reply, so it carries no number. */
export function AnsweredWhileWorking() {
  const { t } = useLingui();
  return (
    <p data-testid="answered-while-working" className="mt-1.5 text-[12px] text-ink-3">
      {t`Answered while the work continues`}
    </p>
  );
}
