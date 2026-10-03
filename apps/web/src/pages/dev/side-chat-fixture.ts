import type { ChatSummary, ThreadMessage } from "@aiden/contracts";

// Fixture data for /dev/side-chats (SideChatsPreviewPage.tsx). A bank-workplace flavor,
// matching the Muse's own profile (museBotProfile in @aiden/contracts), without naming a
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

export const SIDE_CHAT_FIXTURE_MESSAGES: Record<string, ThreadMessage[]> = {
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
