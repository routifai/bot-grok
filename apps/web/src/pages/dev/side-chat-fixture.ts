import type { ChatSummary, ReplyCardBlock, ThreadMessage } from "@nova/contracts";

// Fixture data for /dev/side-chats (SideChatsPreviewPage.tsx). A bank-workplace flavor,
// matching the Muse's own profile (museBotProfile in @nova/contracts), without naming a
// real bank.

export const DEV_BOT_ID = "dev-muse";
export const DEV_MUSE_NAME = "Nova";
export const DEV_MUSE_COLOR = "#0090FF";
export const DEV_PERSON_NAME = "Jordan";

export const DEV_SUMMARY =
  "You're preparing the Q3 branch operations review: staffing levels across three branches, a backlog of loan file audits, and a vendor contract renewal that's still being negotiated.";

function fixtureMessage(
  chatId: string,
  seq: number,
  role: "user" | "bot",
  text: string,
): ThreadMessage {
  return {
    id: `${chatId}-${seq}`,
    threadId: chatId,
    seq,
    role,
    blocks: [{ kind: "text", text }],
    createdAt: new Date(Date.now() - (20 - seq) * 60_000).toISOString(),
  };
}

function cardMessage(
  seq: number,
  fallback: string,
  card: Omit<ReplyCardBlock, "kind" | "fallback">,
): ThreadMessage {
  return {
    id: `side-cards-${seq}`,
    threadId: "side-cards",
    seq,
    role: "bot",
    blocks: [{ kind: "reply_card", fallback, ...card }],
    createdAt: new Date(Date.now() - (30 - seq) * 60_000).toISOString(),
  };
}

/** One of every reply card kind (packages/contracts/src/reply-cards.ts), for /dev/side-chats. */
const CARD_FIXTURE_MESSAGES: ThreadMessage[] = [
  fixtureMessage("side-cards", 1, "user", "Compare the three assistants for the vendor review."),
  cardMessage(2, "Comparison of three assistants.", {
    card: "compare",
    title: "Assistants compared",
    data: {
      columns: ["Dots", "Muse", "Grok Bot"],
      rows: [
        {
          label: "Proactivity",
          cells: [
            "Always-on, acts in background",
            "Follows topics, checks in",
            "Replies when asked",
          ],
        },
        { label: "Approvals", cells: ["Per action", "Before anything irreversible", "None"] },
        { label: "Computer", cells: ["Browser only", "Full workspace", "Sandbox"] },
      ],
    },
  }),
  fixtureMessage(
    "side-cards",
    3,
    "bot",
    "Muse is the only one that asks before irreversible actions.",
  ),
  cardMessage(4, "ACME Bancorp: 48.27 USD, up 1.2%.", {
    card: "quote",
    data: {
      symbol: "ACME",
      name: "ACME Bancorp",
      price: 48.27,
      currency: "USD",
      change: 0.57,
      changePct: 1.19,
      asOf: "Oct 4, 4:00 PM",
      source: "Example Markets",
    },
  }),
  cardMessage(5, "Plan: 1 of 4 done.", {
    card: "plan",
    id: "plan-review",
    title: "Branch review prep",
    data: {
      items: [
        { text: "Pull staffing levels for three branches", status: "done" },
        { text: "Audit the loan file backlog", status: "doing" },
        { text: "Draft the vendor renewal summary", status: "todo" },
        { text: "Send the review pack", status: "todo" },
      ],
    },
  }),
  cardMessage(6, "Which branch first?", {
    card: "ask",
    id: "ask-branch",
    data: {
      question: "Which branch should I start with?",
      options: [
        { id: "riverside", label: "Riverside" },
        { id: "lakeview", label: "Lakeview" },
        { id: "downtown", label: "Downtown" },
      ],
      allowFreeText: true,
    },
  }),
  cardMessage(7, "Three sources.", {
    card: "sources",
    data: {
      items: [
        {
          title: "Introducing always-on agents",
          url: "https://example.com/blog/always-on-agents",
          snippet:
            "Agents that keep working after the conversation ends, with approvals per action.",
        },
        { title: "Assistant approvals, explained", url: "https://docs.example.org/approvals" },
        { title: "Unsafe link kept as text", url: "javascript:alert(1)" },
      ],
    },
  }),
  cardMessage(8, "Branch visits by week.", {
    card: "chart",
    title: "Branch visits per week",
    data: {
      kind: "bar",
      x: ["W36", "W37", "W38", "W39", "W40"],
      series: [{ name: "Visits", values: [12, 18, 9, 22, 17] }],
    },
  }),
  cardMessage(9, "Dana Whitfield, Head of Operations.", {
    card: "person",
    data: {
      name: "Dana Whitfield",
      role: "Head of Operations",
      org: "Example Bank",
      email: "dana@example.com",
      phone: "+1 555 0100",
      url: "https://example.com/team/dana",
    },
  }),
  cardMessage(10, "Q3 review pack, PDF, 1.4 MB.", {
    card: "file",
    data: {
      name: "Q3-review-pack.pdf",
      kind: "PDF",
      size: 1_468_006,
      url: "https://example.com/q3.pdf",
    },
  }),
  cardMessage(11, "Import: 62%.", {
    card: "progress",
    id: "import",
    data: { label: "Importing loan files", value: 62, status: "running" },
  }),
  cardMessage(12, "Import finished.", {
    card: "progress",
    id: "import",
    data: { label: "Importing loan files", value: 100, status: "done" },
  }),
  cardMessage(13, "Drafting the summary.", {
    card: "sources",
    id: "pending-sources",
    data: {},
    pending: true,
  }),
  cardMessage(14, "A kind this client does not know: **falls back** to the Muse's own words.", {
    card: "hologram",
    data: { anything: true },
  }),
];

export const SIDE_CHAT_FIXTURE_MESSAGES: Record<string, ThreadMessage[]> = {
  "side-cards": CARD_FIXTURE_MESSAGES,
  "side-1": [
    fixtureMessage(
      "side-1",
      1,
      "user",
      "Walk me through every change on the loan file backlog this quarter.",
    ),
    fixtureMessage(
      "side-1",
      2,
      "bot",
      "Two changes: 14 files moved to review in August, and 6 were escalated last week for missing income verification. I'm pulling the escalation list now.",
    ),
  ],
  "side-2": [
    fixtureMessage(
      "side-2",
      1,
      "user",
      "Three branches to visit for Friday's staffing walkthrough.",
    ),
    fixtureMessage(
      "side-2",
      2,
      "bot",
      "Riverside, Lakeview, and the downtown branch — each is short on tellers this week.",
    ),
  ],
  "side-3": [
    fixtureMessage("side-3", 1, "user", "Tighten the new-accounts welcome email."),
    fixtureMessage(
      "side-3",
      2,
      "bot",
      "“Welcome aboard. Your first statement arrives in 30 days — here's what to expect.”",
    ),
  ],
};

export const INITIAL_SIDE_CHATS: ChatSummary[] = [
  {
    id: "side-cards",
    title: "Reply cards",
    start: "blank",
    summary: null,
    archived: false,
    live: false,
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
  },
  {
    id: "side-1",
    title: "Loan file backlog",
    start: "withContext",
    summary: DEV_SUMMARY,
    archived: false,
    live: true,
    updatedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
  },
  {
    id: "side-2",
    title: "Friday branch walkthrough",
    start: "blank",
    summary: null,
    archived: false,
    live: false,
    updatedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
  },
  {
    id: "side-3",
    title: "New-accounts email copy",
    start: "blank",
    summary: null,
    archived: true,
    live: false,
    updatedAt: new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString(),
  },
];
