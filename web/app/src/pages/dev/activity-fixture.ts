import type { Activity, ActivityStep, ThreadMessage } from "@superchat/contracts";

// Fixture data for /dev/activity (ActivityPreviewPage.tsx): the Activity panel on in-memory
// data, so the panel's grouping, live line, and run page can be reviewed without the
// Omnigent backend (`activities.*` isn't served by the local dev API). Steps use real engine tool names and realistic
// payloads (engine/omnigent/tools/builtins/) so the icon + title + snippet registry
// (web/packages/core/src/tool-presentation.ts) has something true to life to present.

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

/** A tool call's detail in the engine's own shape (engine/omnigent/tools/builtins/
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

// The work strip under a reply (WorkStrip.tsx): a deck Helper that has reported progress and
// raised a flag, and a reading Helper that finished in 2:14.
const DECK_STARTED = minutesAgo(1.2);
export const DECK_HELPER_CHAT_ID = "helper-deck";
export const READ_HELPER_CHAT_ID = "helper-read";

export const INITIAL_ACTIVITIES: Activity[] = [
  {
    id: "act-helper-deck",
    kind: "sub_agent",
    source: "background",
    chatId: DECK_HELPER_CHAT_ID,
    parentChatId: "conv-1",
    title: "Write the Q3 lending deck",
    outcome: null,
    summary: null,
    status: "in_progress",
    startedAt: DECK_STARTED,
    finishedAt: null,
    date: dateOf(DECK_STARTED),
    steps: [
      {
        itemId: "deck-1",
        title: "Read the Q2 review for its structure",
        createdAt: minutesAgo(1),
        tool: "report_progress",
      },
      {
        itemId: "deck-2",
        title: "Flagged: Ledger says 6.1% loan growth, the memo says 5.4%; using the ledger",
        createdAt: minutesAgo(0.8),
        tool: "raise_flag",
      },
      {
        itemId: "deck-3",
        title: "Slide 6 of 10 written",
        createdAt: minutesAgo(0.2),
        tool: "report_progress",
      },
    ],
  },
  {
    id: "act-helper-read",
    kind: "sub_agent",
    source: "background",
    chatId: READ_HELPER_CHAT_ID,
    parentChatId: "conv-1",
    title: "Read the three files you dropped",
    outcome: "Read the ledger, the memo and the provisions sheet.",
    summary: "Read the ledger, the memo and the provisions sheet.",
    status: "done",
    startedAt: minutesAgo(30),
    finishedAt: new Date(now - 30 * 60_000 + 134_000).toISOString(),
    date: dateOf(minutesAgo(30)),
  },
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
    source: "turn",
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
    source: "scheduled",
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

// The plan in the work strip (ADR 0023): the assistant's living `plan` card, rendered again with
// the same id as steps start and finish. Each scenario is a reply as the transcript holds it (the
// person's message, the reply's text, its plan renders), read by the real `transcriptWork`.

type PlanItem = { text: string; status: "todo" | "doing" | "done" };

const READ = "Read mock_markets.csv";
const SHARES = "Work out shares and the trend";
const BUILD = "Build six slides";
const NOTE = "Note the 16 October cut-off on the trend slide";
const CHECK = "Check every figure against the file";

const plan = (...items: Array<[string, PlanItem["status"]]>): PlanItem[] =>
  items.map(([text, status]) => ({ text, status }));

/** The deck reply's plan as it evolves: the third render adds a step after a flag. */
export const DECK_PLAN_RENDERS: PlanItem[][] = [
  plan([READ, "doing"], [SHARES, "todo"], [BUILD, "todo"], [CHECK, "todo"]),
  plan([READ, "done"], [SHARES, "doing"], [BUILD, "todo"], [CHECK, "todo"]),
  plan([READ, "done"], [SHARES, "done"], [BUILD, "doing"], [NOTE, "todo"], [CHECK, "todo"]),
  plan([READ, "done"], [SHARES, "done"], [BUILD, "done"], [NOTE, "doing"], [CHECK, "todo"]),
  plan([READ, "done"], [SHARES, "done"], [BUILD, "done"], [NOTE, "done"], [CHECK, "done"]),
];

/** What the deck Helper has reported by each render. */
const DECK_PROGRESS = [
  "Reading 8 tickers across 3 regions",
  "Europe 38.3%, North America 37.1%, Asia 24.7%",
  "Slide 3 of 6: volume share by region",
  "Date note added to slide 5",
  "48 figures checked, all match the file",
];
const DECK_FLAG = "The data ends on 16 October, not 20 October as the file name says.";

export const PLAN_HELPER_CHAT_ID = "helper-plan-deck";
const PLAN_ASKED = minutesAgo(1.4);

function planCard(id: string, items: PlanItem[], seq: number, at: string): ThreadMessage {
  return {
    id: `card-${id}-${seq}`,
    threadId: "conv-1",
    seq,
    role: "bot",
    blocks: [
      {
        kind: "reply_card",
        card: "plan",
        id,
        data: { items },
        fallback: items.map((item) => item.text).join("\n"),
      },
    ],
    createdAt: at,
  };
}

function ask(id: string, text: string, at: string): ThreadMessage {
  return {
    id,
    threadId: "conv-1",
    seq: 0,
    role: "user",
    blocks: [{ kind: "text", text }],
    createdAt: at,
  };
}

/** The deck reply after `renders` plan renders, with its Helper. */
export function deckPlanMessages(renders: number): ThreadMessage[] {
  const shown = DECK_PLAN_RENDERS.slice(0, Math.max(1, renders));
  return [
    ask(
      "ask-deck",
      "Make a presentation from mock_markets.csv: volume by region and the trend, about six slides with charts I can edit.",
      PLAN_ASKED,
    ),
    ...shown.map((items, index) => planCard("plan-deck", items, index + 1, PLAN_ASKED)),
    {
      id: "reply-deck",
      threadId: "conv-1",
      seq: 9,
      role: "bot",
      blocks: [
        {
          kind: "text",
          text: "I'll read the CSV, work out each region's share and the trend, and build a six-slide deck with charts you can edit.",
        },
        {
          kind: "helper",
          helperId: PLAN_HELPER_CHAT_ID,
          title: "Build the markets deck",
          status: "in_progress",
        },
      ],
      createdAt: PLAN_ASKED,
    },
  ];
}

/** The deck Helper as the feed lists it after `renders` renders: running until the last. */
export function deckPlanHelper(renders: number): Activity {
  const done = renders >= DECK_PLAN_RENDERS.length;
  const steps: ActivityStep[] = DECK_PROGRESS.slice(0, Math.max(1, renders)).map(
    (title, index) => ({
      itemId: `plan-deck-${index}`,
      title,
      createdAt: minutesAgo(1.3 - index * 0.2),
      tool: "report_progress",
    }),
  );
  if (renders >= 3) {
    steps.splice(2, 0, {
      itemId: "plan-deck-flag",
      title: `Flagged: ${DECK_FLAG}`,
      createdAt: minutesAgo(0.8),
      tool: "raise_flag",
    });
  }
  return {
    id: "act-helper-plan-deck",
    kind: "sub_agent",
    source: "background",
    chatId: PLAN_HELPER_CHAT_ID,
    parentChatId: "conv-1",
    title: "Build the markets deck",
    outcome: done ? "Six slides, every chart editable." : null,
    summary: done ? "Six slides, every chart editable." : null,
    status: done ? "done" : "in_progress",
    startedAt: minutesAgo(1.35),
    finishedAt: done ? new Date(Date.parse(minutesAgo(1.35)) + 101_000).toISOString() : null,
    date: dateOf(PLAN_ASKED),
    steps,
  };
}

const SOLO_ASKED = minutesAgo(0.3);

/** A reply the assistant works on alone, still running: a plan and no Helper. */
export const SOLO_PLAN_MESSAGES: ThreadMessage[] = [
  ask(
    "ask-solo",
    "Compare Q2 and Q3 volumes in mock_markets.csv and tell me what changed.",
    SOLO_ASKED,
  ),
  {
    id: "reply-solo",
    threadId: "conv-1",
    seq: 1,
    role: "bot",
    blocks: [
      {
        kind: "text",
        text: "I'll split the rows by quarter, compare each region, and tell you the two or three changes that matter.",
      },
    ],
    createdAt: SOLO_ASKED,
  },
  planCard(
    "plan-solo",
    plan(
      ["Split the rows into Q2 and Q3", "done"],
      ["Compare each region", "doing"],
      ["Pick what matters", "todo"],
    ),
    2,
    SOLO_ASKED,
  ),
];
