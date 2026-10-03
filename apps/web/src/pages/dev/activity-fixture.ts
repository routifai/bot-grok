import type { Activity, ActivityStep, ThreadMessage } from "@aiden/contracts";

// Fixture data for /dev/activity (ActivityPreviewPage.tsx): the Activity panel on in-memory
// data, so the panel's grouping, live line, and run page can be reviewed without the
// Omnigent backend (`activities.*` isn't served by the local dev API). Same reasoning as
// /dev/side-chats (side-chat-fixture.ts).

const now = Date.now();
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const hoursAgo = (hours: number) => new Date(now - hours * 60 * 60_000).toISOString();
const daysAgo = (days: number) => new Date(now - days * 24 * 60 * 60_000).toISOString();

function dateOf(iso: string): string {
  return iso.slice(0, 10);
}

export const DEV_ACTIVITY_BOT_ID = "dev-activity-muse";

/** Fixture for the Memory tab (MemoryTab.tsx / `rpc.memory.profile`'s shape). */
export const DEV_MEMORY_PROFILE = [
  "[Standing memory about the user — provided by the system, not a message from the user]",
  "",
  "Preferences:",
  "- Prefers phone-first slide decks",
  "- Weekly branch KPI summary on Monday mornings",
  "",
  "About the user:",
  "- Works branch operations at a bank",
  "- Reviews the Q3 steering deck with Dana",
  "",
  "[End of standing memory]",
].join("\n");

const HELPER_STARTED = minutesAgo(4);
const HELPER_CHAT_ID = "helper-1";

export const INITIAL_ACTIVITIES: Activity[] = [
  {
    id: "act-helper-running",
    kind: "sub_agent",
    chatId: HELPER_CHAT_ID,
    title: "Check the Q3 budget totals",
    outcome: "Comparing line 61 of 84.",
    status: "in_progress",
    startedAt: HELPER_STARTED,
    finishedAt: null,
    date: dateOf(HELPER_STARTED),
  },
  {
    id: "act-turn-drafted",
    kind: "turn",
    chatId: "conv-1",
    title: "Drafted the steering review",
    outcome: "4 slides, phone-first, ready for edits.",
    status: "done",
    startedAt: minutesAgo(40),
    finishedAt: minutesAgo(38),
    date: dateOf(minutesAgo(40)),
  },
  {
    id: "act-turn-failed",
    kind: "turn",
    chatId: "conv-1",
    title: "Retrieve idea details",
    outcome: "The ideas store didn't answer.",
    status: "failed",
    startedAt: hoursAgo(5),
    finishedAt: hoursAgo(5),
    date: dateOf(hoursAgo(5)),
  },
  {
    id: "act-helper-done-yesterday",
    kind: "sub_agent",
    chatId: "helper-2",
    title: "Summarize today's headlines",
    outcome: "A 5-point summary of today's headlines.",
    status: "done",
    startedAt: daysAgo(1),
    finishedAt: daysAgo(1),
    date: dateOf(daysAgo(1)),
  },
  {
    id: "act-turn-cancelled",
    kind: "turn",
    chatId: "conv-1",
    title: "Pull last quarter's branch KPIs",
    outcome: null,
    status: "cancelled",
    startedAt: daysAgo(1),
    finishedAt: daysAgo(1),
    date: dateOf(daysAgo(1)),
  },
  {
    id: "act-turn-older",
    kind: "turn",
    chatId: "conv-1",
    title: "Tightened the new-accounts welcome email",
    outcome: "Shortened it to three lines.",
    status: "done",
    startedAt: daysAgo(6),
    finishedAt: daysAgo(6),
    date: dateOf(daysAgo(6)),
  },
];

/** A second, older page for "Load earlier" — returned once `before` is older than
 * every Activity above. */
export const EARLIER_ACTIVITIES: Activity[] = [
  {
    id: "act-turn-earliest",
    kind: "turn",
    chatId: "conv-1",
    title: "Set up the weekly KPI routine",
    outcome: "Scheduled for Monday mornings.",
    status: "done",
    startedAt: daysAgo(12),
    finishedAt: daysAgo(12),
    date: dateOf(daysAgo(12)),
  },
];

const HELPER_STEPS: ActivityStep[] = [
  {
    itemId: "step-1",
    title: "Opened budget.xlsx and the ledger export",
    createdAt: minutesAgo(4),
    tool: "read_file",
    detail: null,
  },
  {
    itemId: "step-2",
    title: "Matched 61 of 84 line items",
    createdAt: minutesAgo(1),
    tool: "compare",
    detail: { matched: "61", total: "84", differs: "0" },
  },
];

const DONE_TURN_STEPS: ActivityStep[] = [
  {
    itemId: "step-a",
    title: "Read last week's thread and the risk register",
    createdAt: minutesAgo(40),
    tool: "session_history",
    detail: null,
  },
  {
    itemId: "step-b",
    title: "Drafted 4 slides sized for a phone screen",
    createdAt: minutesAgo(38),
    tool: "write_file",
    detail: { file: "steering-review.pdf" },
  },
];

const DETAIL_BY_ID: Record<string, ActivityStep[]> = {
  "act-helper-running": HELPER_STEPS,
  "act-turn-drafted": DONE_TURN_STEPS,
};

export function activityDetail(activityId: string): ActivityStep[] {
  return DETAIL_BY_ID[activityId] ?? [];
}

export const HELPER_MESSAGES: Record<string, ThreadMessage[]> = {
  [HELPER_CHAT_ID]: [
    {
      id: "helper-m1",
      threadId: HELPER_CHAT_ID,
      seq: 1,
      role: "user",
      blocks: [
        {
          kind: "text",
          text: "Compare the Q3 ledger against the budget sheet, line by line, and flag anything that differs.",
        },
      ],
      createdAt: HELPER_STARTED,
    },
    {
      id: "helper-m2",
      threadId: HELPER_CHAT_ID,
      seq: 2,
      role: "bot",
      blocks: [
        {
          kind: "text",
          text: "Opened both files and started matching 84 line items. 61 are done so far; everything has tied out except Vendor Services, which I'm still checking.",
        },
      ],
      createdAt: minutesAgo(1),
    },
  ],
};
