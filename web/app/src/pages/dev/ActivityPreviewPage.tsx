import type { Activity, ThreadMessage, ThreadMessagePage } from "@superchat/contracts";
import { type ReactNode, useMemo, useState } from "react";
import { useNow } from "../../components/chrome/useNow";
import {
  type ActivitiesState,
  type ActivityWire,
  AnsweredWhileWorking,
  focusActivity,
  transcriptWork,
  WorkingPill,
  WorkStripView,
} from "../../features/activity";
import {
  composeStrip,
  deriveWorkStrip,
  flagsOf,
  helperActivities,
  type StripHelper,
} from "../../features/activity/workStripState";
import type { MemoryWire } from "../../features/memory";
import { ContextPanel } from "../app/chrome/ContextPanel";
import {
  activityDetail,
  DECK_HELPER_CHAT_ID,
  DECK_PLAN_RENDERS,
  DEV_ACTIVITY_BOT_ID,
  DEV_MEMORY_PROFILE,
  deckPlanHelper,
  deckPlanMessages,
  EARLIER_ACTIVITIES,
  HELPER_MESSAGES,
  INITIAL_ACTIVITIES,
  READ_HELPER_CHAT_ID,
  SOLO_PLAN_MESSAGES,
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

function Reply({
  children,
  below,
  fixture,
}: {
  children: string;
  below?: ReactNode;
  fixture?: string;
}) {
  return (
    <div data-fixture={fixture} className="max-w-full self-start">
      <p className="muse-reply text-[15px] leading-[1.47] tracking-[-0.24px] text-foreground">
        {children}
      </p>
      {below}
    </div>
  );
}

/** One reply's strip as the transcript draws it: its plan read by `transcriptWork`, its Helpers
 * from the fixture feed. */
function PlanStrip({
  messages,
  activities,
  live,
  liveLabel,
  drafts,
}: {
  messages: ThreadMessage[];
  activities: Activity[];
  live: boolean;
  liveLabel?: string;
  drafts?: Parameters<typeof WorkStripView>[0]["drafts"];
}) {
  const turn = [...transcriptWork(messages).turns.values()][0];
  const helpersLive = turn
    ? deriveWorkStrip(turn.helpers, activities, 0).kind === "working"
    : false;
  const now = useNow(live || helpersLive);
  if (!turn) return null;
  const view = composeStrip(
    deriveWorkStrip(turn.helpers, activities, now),
    helperActivities(turn.helpers, activities).flatMap(flagsOf),
    {
      plan: turn.plan,
      live,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      ...(liveLabel ? { liveLabel } : {}),
    },
    now,
  );
  return (
    <WorkStripView view={view} drafts={drafts} onShowDetails={() => focusActivity(view.focusId)} />
  );
}

const firstText = (messages: ThreadMessage[], id: string) => {
  const block = messages.find((message) => message.id === id)?.blocks[0];
  return block?.kind === "text" ? block.text : "";
};

/** The deck reply's plan, one render at a time (the third adds a step after a flag). */
function DeckPlanPreview() {
  const [renders, setRenders] = useState(() => {
    const asked = Number(new URLSearchParams(window.location.search).get("renders"));
    return asked >= 1 && asked <= DECK_PLAN_RENDERS.length - 1 ? asked : 3;
  });
  const messages = useMemo(() => deckPlanMessages(renders), [renders]);
  const activities = useMemo(() => [deckPlanHelper(renders)], [renders]);
  const drafts =
    renders >= 3
      ? [
          {
            artifactId: "dev-markets-deck",
            name: "mock-markets.deck.html",
            version: renders - 2,
            mimeType: "text/html",
          },
        ]
      : [];
  return (
    <>
      <Mine>{firstText(messages, "ask-deck")}</Mine>
      <Reply
        fixture="plan-running"
        below={
          <PlanStrip messages={messages} activities={activities} live={false} drafts={drafts} />
        }
      >
        {firstText(messages, "reply-deck")}
      </Reply>
      <div className="flex gap-2 self-start text-[12px] text-ink-3">
        <button
          type="button"
          className="underline"
          onClick={() => setRenders((value) => Math.max(1, value - 1))}
        >
          Previous render
        </button>
        <button
          type="button"
          className="underline"
          onClick={() => setRenders((value) => Math.min(DECK_PLAN_RENDERS.length - 1, value + 1))}
        >
          Next render
        </button>
        <span>
          {renders} of {DECK_PLAN_RENDERS.length - 1}
        </span>
      </div>
    </>
  );
}

const SETTLED_MESSAGES = deckPlanMessages(DECK_PLAN_RENDERS.length);
const SETTLED_ACTIVITIES = [deckPlanHelper(DECK_PLAN_RENDERS.length)];
const PILL_STARTED = Date.now() - 12_000;

/** The work strip under replies, on the same fixture feed as the panel: Show details opens the
 * panel beside it on the Helper. */
function WorkPreview({ activities }: { activities: Activity[] | undefined }) {
  const now = useNow(true);
  const deck = composeStrip(deriveWorkStrip(DECK_HELPERS, activities, now), [], undefined, now);
  const read = composeStrip(deriveWorkStrip(READ_HELPERS, activities, now), [], undefined, now);
  return (
    <div className="sc-scroll flex min-h-0 flex-1 flex-col overflow-y-auto rounded-2xl border border-border">
      <div className="flex h-[66px] shrink-0 items-center justify-end px-6">
        <span data-fixture="pill" className="p-1">
          <WorkingPill botId={DEV_ACTIVITY_BOT_ID} turnStartedAt={PILL_STARTED} />
        </span>
      </div>
      <div className="mx-auto flex w-full max-w-[700px] flex-col gap-[22px] px-6 pb-8">
        <DeckPlanPreview />
        <Mine>{firstText(SOLO_PLAN_MESSAGES, "ask-solo")}</Mine>
        <Reply
          fixture="plan-solo"
          below={
            <PlanStrip
              messages={SOLO_PLAN_MESSAGES}
              activities={[]}
              live
              liveLabel="Asia up 11%, Europe flat, North America down 4%"
            />
          }
        >
          {firstText(SOLO_PLAN_MESSAGES, "reply-solo")}
        </Reply>
        <Mine>{firstText(SETTLED_MESSAGES, "ask-deck")}</Mine>
        <Reply
          fixture="plan-settled"
          below={
            <PlanStrip
              messages={SETTLED_MESSAGES}
              activities={SETTLED_ACTIVITIES}
              live={false}
              drafts={[
                {
                  artifactId: "dev-markets-deck",
                  name: "mock-markets.deck.html",
                  version: 3,
                  mimeType: "text/html",
                },
              ]}
            />
          }
        >
          The deck is ready: six slides, every chart editable. Look at slide 3 for the regional
          split and slide 5 for the trend, which stops at 16 October.
        </Reply>
        <Mine>Read the three files I dropped this morning.</Mine>
        <Reply
          fixture="lines-settled"
          below={<WorkStripView view={read} onShowDetails={() => focusActivity(read.focusId)} />}
        >
          I'll read the ledger, the memo and the provisions sheet, then tell you what stands out.
        </Reply>
        <Mine>Now turn it into the Q3 lending deck, like the Q2 one.</Mine>
        <Reply
          fixture="lines-running"
          below={<WorkStripView view={deck} onShowDetails={() => focusActivity(deck.focusId)} />}
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
