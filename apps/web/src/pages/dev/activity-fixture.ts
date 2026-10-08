import type { Activity, ActivityStep, ThreadMessage } from "@nova/contracts";

// Fixture data for /dev/activity (ActivityPreviewPage.tsx): the Activity panel on in-memory
// data, so the panel's grouping, live line, and run page can be reviewed without the
// Omnigent backend (`activities.*` isn't served by the local dev API). Same reasoning as
// /dev/side-chats (side-chat-fixture.ts). Steps use real engine tool names and realistic
// payloads (engine/omnigent/omnigent/tools/builtins/) so the icon + title + snippet registry
// (packages/core/src/tool-presentation.ts) has something true to life to present.

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

/** A tool call's detail in the engine's own shape (engine/omnigent/omnigent/tools/builtins/
 * spawn.py `_project_activity_item`/`_step_detail`): the call's JSON-encoded arguments
 * string, and the result's raw output string (often itself JSON-encoded). */
function toolDetail(tool: string, args: Record<string, unknown>, content: string) {
  return {
    call: { role: "assistant", type: "tool_call", name: tool, args: JSON.stringify(args) },
    result: { role: "tool", type: "tool_result", name: tool, content },
  };
}

const HELPER_STEPS: ActivityStep[] = [
  {
    itemId: "step-1",
    title: "Searched memory for 'Q3 budget totals'",
    createdAt: minutesAgo(4),
    tool: "memory_search",
    detail: toolDetail(
      "memory_search",
      { query: "Q3 budget totals" },
      JSON.stringify({
        results: [{ claim_id: "c1", text: "Dana owns the Q3 budget review", kind: "fact" }],
      }),
    ),
  },
  {
    itemId: "step-2",
    title: "Sent a message to sub-agent 'Q3 budget check'",
    createdAt: minutesAgo(1),
    tool: "sys_session_send",
    detail: toolDetail(
      "sys_session_send",
      {
        agent: "analyst",
        title: "Q3 budget check",
        args: "Compare the Q3 ledger against the budget sheet.",
      },
      JSON.stringify({
        task_id: "task_1",
        kind: "sub_agent",
        agent: "analyst",
        title: "Q3 budget check",
        conversation_id: HELPER_CHAT_ID,
        status: "in_progress",
        message: "Dispatched; result will arrive in the inbox.",
      }),
    ),
  },
];

const DONE_TURN_STEPS: ActivityStep[] = [
  {
    itemId: "step-a",
    title: "Read earlier messages",
    createdAt: minutesAgo(40),
    tool: "session_history",
    detail: toolDetail(
      "session_history",
      { action: "read" },
      JSON.stringify({
        turns: [
          { messages: [{ role: "user", type: "text", content: "What did we decide last week?" }] },
        ],
        next_cursor: null,
      }),
    ),
  },
  {
    itemId: "step-b",
    title: "Used web_search",
    createdAt: minutesAgo(39),
    tool: "web_search",
    detail: toolDetail(
      "web_search",
      { query: "phone-first slide deck design tips" },
      [
        "Short decks read best as single points per slide.",
        "",
        "1. Designing decks for phones\n   https://blog.example.com/phone-decks\n   One idea per slide, large type.",
        "2. Steering review best practices\n   https://www.investopedia.com/steering-review\n   Keep it to one page per topic.",
      ].join("\n"),
    ),
  },
  {
    itemId: "step-c",
    title: "Drafted 4 slides sized for a phone screen",
    createdAt: minutesAgo(38),
    tool: "write_file",
    detail: toolDetail("write_file", { file: "steering-review.pdf" }, "Saved steering-review.pdf"),
  },
];

export const INITIAL_ACTIVITIES: Activity[] = [
  {
    id: "act-helper-running",
    kind: "sub_agent",
    source: "background",
    chatId: HELPER_CHAT_ID,
    title: "Check the Q3 budget totals",
    outcome: "Comparing line 61 of 84.",
    summary: "Comparing line 61 of 84.",
    status: "in_progress",
    startedAt: HELPER_STARTED,
    finishedAt: null,
    date: dateOf(HELPER_STARTED),
    // Present on the list summary too (not just `activities.get`) so the row's live line
    // can show the latest Step's icon + title while this Activity is still in progress.
    steps: HELPER_STEPS,
  },
  {
    id: "act-turn-drafted",
    kind: "turn",
    source: "turn",
    chatId: "conv-1",
    title: "Drafted the steering review",
    outcome: "4 slides, phone-first, ready for edits.",
    summary: "4 slides, phone-first, ready for edits.",
    status: "done",
    startedAt: minutesAgo(40),
    finishedAt: minutesAgo(38),
    date: dateOf(minutesAgo(40)),
  },
  {
    id: "act-turn-failed",
    kind: "turn",
    source: "turn",
    chatId: "conv-1",
    title: "Retrieve idea details",
    outcome: "The ideas store didn't answer.",
    summary: "The ideas store didn't answer.",
    status: "failed",
    startedAt: hoursAgo(5),
    finishedAt: hoursAgo(5),
    date: dateOf(hoursAgo(5)),
  },
  {
    id: "act-helper-done-yesterday",
    kind: "sub_agent",
    source: "scheduled",
    chatId: "helper-2",
    title: "Summarize today's headlines",
    outcome: "A 5-point summary of today's headlines.",
    summary: "A 5-point summary of today's headlines.",
    status: "done",
    startedAt: daysAgo(1),
    finishedAt: daysAgo(1),
    date: dateOf(daysAgo(1)),
  },
  {
    id: "act-turn-cancelled",
    kind: "turn",
    source: "side_chat",
    chatId: "conv-1",
    title: "Pull last quarter's branch KPIs",
    outcome: null,
    summary: null,
    status: "cancelled",
    startedAt: daysAgo(1),
    finishedAt: daysAgo(1),
    date: dateOf(daysAgo(1)),
  },
  {
    id: "act-turn-older",
    kind: "turn",
    source: "turn",
    chatId: "conv-1",
    title: "Tightened the new-accounts welcome email",
    outcome: "Shortened it to three lines.",
    summary: "Shortened it to three lines.",
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
    source: "goal",
    chatId: "conv-1",
    title: "Set up the weekly KPI routine",
    outcome: "Scheduled for Monday mornings.",
    summary: "Scheduled for Monday mornings.",
    status: "done",
    startedAt: daysAgo(12),
    finishedAt: daysAgo(12),
    date: dateOf(daysAgo(12)),
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
