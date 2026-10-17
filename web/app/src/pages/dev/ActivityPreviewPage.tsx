import type { Activity, ThreadMessagePage } from "@superchat/contracts";
import { type ReactNode, useMemo, useState } from "react";
import { useNow } from "../../components/chrome/useNow";
import {
  type ActivitiesState,
  type ActivityWire,
  AnsweredWhileWorking,
  focusActivity,
  WorkStripView,
} from "../../features/activity";
import { deriveWorkStrip, type StripHelper } from "../../features/activity/workStripState";
import type { MemoryWire } from "../../features/memory";
import { ContextPanel } from "../app/chrome/ContextPanel";
import {
  activityDetail,
  DECK_HELPER_CHAT_ID,
  DEV_ACTIVITY_BOT_ID,
  DEV_MEMORY_PROFILE,
  EARLIER_ACTIVITIES,
  HELPER_MESSAGES,
  INITIAL_ACTIVITIES,
  READ_HELPER_CHAT_ID,
} from "./activity-fixture";
import { DEV_MUSE_NAME } from "./dev-muse";

const DECK_HELPERS: StripHelper[] = [
  { helperId: DECK_HELPER_CHAT_ID, title: "Write the Q3 lending deck", status: "in_progress" },
];
const READ_HELPERS: StripHelper[] = [
  { helperId: READ_HELPER_CHAT_ID, title: "Read the three files", status: "done" },
];

function Mine({ children }: { children: string }) {
  return (
    <div className="sc-user-bubble self-end rounded-2xl px-4 py-3 text-[15px] leading-[1.6] text-foreground">
      {children}
    </div>
  );
}

function Reply({ children, below }: { children: string; below?: ReactNode }) {
  return (
    <div className="max-w-full self-start">
      <p className="muse-reply text-[15px] leading-[1.47] tracking-[-0.24px] text-foreground">
        {children}
      </p>
      {below}
    </div>
  );
}

/** The work strip under replies, on the same fixture feed as the panel: Show details opens the
 * panel beside it on the Helper. */
function WorkPreview({ activities }: { activities: Activity[] | undefined }) {
  const now = useNow(true);
  const deck = deriveWorkStrip(DECK_HELPERS, activities, now);
  const read = deriveWorkStrip(READ_HELPERS, activities, now);
  return (
    <div className="sc-scroll flex min-h-0 flex-1 justify-center overflow-y-auto rounded-2xl border border-border">
      <div className="flex w-full max-w-[700px] flex-col gap-[22px] px-6 py-8">
        <Mine>Read the three files I dropped this morning.</Mine>
        <Reply
          below={<WorkStripView state={read} onShowDetails={() => focusActivity(read.focusId)} />}
        >
          I'll read the ledger, the memo and the provisions sheet, then tell you what stands out.
        </Reply>
        <Mine>Now turn it into the Q3 lending deck, like the Q2 one.</Mine>
        <Reply
          below={<WorkStripView state={deck} onShowDetails={() => focusActivity(deck.focusId)} />}
        >
          I'll build it on the Q2 structure. The growth figures differ between the ledger and the
          memo; I'm going with the ledger and will mark it on the slide.
        </Reply>
        <Mine>When is the committee again?</Mine>
        <Reply below={<AnsweredWhileWorking />}>
          Thursday at 10:00, from your note on Monday. The deck keeps going.
        </Reply>
      </div>
    </div>
  );
}

function delay<T>(value: T, ms = 350): Promise<T> {
  return new Promise((resolve) => {
    window.setTimeout(() => resolve(value), ms);
  });
}

/**
 * Dev-only route (`/dev/activity`, gated by `import.meta.env.DEV`): the real context panel — identity header, segmented tabs, Activity,
 * and Memory — on in-memory fixture data, at its real width (ContextPanel.tsx's own
 * `w-[340px]`) beside a stand-in Conversation that shows the work strip under replies. `activitiesOverride` and
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
      <WorkPreview activities={state.status === "ready" ? state.activities : undefined} />
      <ContextPanel
        botId={DEV_ACTIVITY_BOT_ID}
        museName={DEV_MUSE_NAME}
        collapsed={false}
        onOpenWaiting={() => undefined}
        activitiesOverride={{ state, wire: activityWire, loadEarlier, loadingEarlier }}
        memoryWire={memoryWire}
      />
    </div>
  );
}
