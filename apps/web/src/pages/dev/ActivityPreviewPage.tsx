import type { Activity, ThreadMessagePage } from "@aiden/contracts";
import { useMemo, useState } from "react";
import type { ActivityWire } from "../muse/chrome/ActivityRunDialog";
import { ContextPanel } from "../muse/chrome/ContextPanel";
import type { MemoryWire } from "../muse/chrome/MemoryTab";
import type { ActivitiesState } from "../muse/chrome/useActivities";
import {
  activityDetail,
  DEV_ACTIVITY_BOT_ID,
  DEV_MEMORY_PROFILE,
  EARLIER_ACTIVITIES,
  HELPER_MESSAGES,
  INITIAL_ACTIVITIES,
} from "./activity-fixture";
import { DEV_MUSE_NAME } from "./side-chat-fixture";

function delay<T>(value: T, ms = 350): Promise<T> {
  return new Promise((resolve) => {
    window.setTimeout(() => resolve(value), ms);
  });
}

/**
 * Dev-only route (`/dev/activity`, gated by `import.meta.env.DEV`, following
 * `/dev/side-chats`): the real context panel — identity header, segmented tabs, Activity,
 * and Memory — on in-memory fixture data, at its real width (ContextPanel.tsx's own
 * `w-[340px]`) beside a blank stand-in for the Conversation. `activitiesOverride` and
 * `memoryWire` are ContextPanel's dev-preview seams; the local dev API doesn't serve
 * `activities.*` or `memory.profile` yet, so this reviews the panel without a backend.
 */
export function ActivityPreviewPage() {
  const [state, setState] = useState<ActivitiesState>({
    status: "ready",
    activities: INITIAL_ACTIVITIES,
    hasMore: true,
  });
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  const activityWire = useMemo<ActivityWire>(
    () => ({
      get: (input) =>
        delay(
          (INITIAL_ACTIVITIES.find((a) => a.id === input.activityId) ??
            EARLIER_ACTIVITIES.find((a) => a.id === input.activityId) ?? {
              id: input.activityId,
              kind: "turn",
              source: "turn",
              chatId: "conv-1",
              title: "",
              outcome: null,
              summary: null,
              status: "done",
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
              date: new Date().toISOString().slice(0, 10),
            }) as Activity,
        ).then((activity) => ({ ...activity, steps: activityDetail(activity.id) })),
      helperMessages: (input): Promise<ThreadMessagePage> =>
        delay({
          threadId: input.chatId,
          messages: HELPER_MESSAGES[input.chatId] ?? [],
          olderCursor: null,
        }),
    }),
    [],
  );

  const memoryWire = useMemo<MemoryWire>(
    () => ({ profile: () => delay({ profile: DEV_MEMORY_PROFILE }) }),
    [],
  );

  const loadEarlier = async () => {
    if (loadingEarlier || state.status !== "ready" || !state.hasMore) return;
    setLoadingEarlier(true);
    const page = await delay({ activities: EARLIER_ACTIVITIES, hasMore: false });
    setState((current) =>
      current.status === "ready"
        ? {
            status: "ready",
            activities: [...current.activities, ...page.activities],
            hasMore: page.hasMore,
          }
        : current,
    );
    setLoadingEarlier(false);
  };

  return (
    <div className="flex h-screen gap-2 bg-background p-2">
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-2xl border border-dashed border-border text-[13px] text-muted-foreground">
        Conversation — not part of this preview
      </div>
      <ContextPanel
        botId={DEV_ACTIVITY_BOT_ID}
        museName={DEV_MUSE_NAME}
        collapsed={false}
        onNavigate={() => undefined}
        onOpenWaiting={() => undefined}
        activitiesOverride={{ state, wire: activityWire, loadEarlier, loadingEarlier }}
        memoryWire={memoryWire}
      />
    </div>
  );
}
