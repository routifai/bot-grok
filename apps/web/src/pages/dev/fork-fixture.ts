import type { ChatSummary, MessageFork, ThreadMessage } from "@aiden/contracts";

// Fixture data for /dev/forks (ForksPreviewPage.tsx): a Conversation with forks in every
// state, in the bank-workplace flavor of ./side-chat-fixture.ts, without naming a real bank.

export const FORK_DEV_CONVERSATION = "conv-dev";

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

function say(
  id: string,
  role: "user" | "bot",
  text: string,
  at: string,
  threadId = FORK_DEV_CONVERSATION,
): ThreadMessage {
  return { id, threadId, seq: 0, role, blocks: [{ kind: "text", text }], createdAt: at, forks: [] };
}

type ForkSeed = {
  id: string;
  anchor: string;
  title: string;
  state: MessageFork["state"];
  live?: boolean;
  summary?: string;
  updatedAt: string;
  messages: Array<["user" | "bot", string]>;
};

export const FORK_SEEDS: ForkSeed[] = [
  {
    id: "fork-chart",
    anchor: "m2",
    title: "Slide 7 chart type",
    state: "added",
    summary: "Slide 7 becomes a bar chart by segment, small business highlighted",
    updatedAt: daysAgo(1),
    messages: [
      ["user", "Bars or a waterfall for slide 7?"],
      ["bot", "Bars by segment. Dana reads them faster, and a waterfall needs a legend."],
      ["user", "Bars. Highlight small business."],
      ["bot", "Done."],
    ],
  },
  {
    id: "fork-margin",
    anchor: "m4",
    title: "6.6% and margin",
    state: "open",
    live: true,
    updatedAt: minutesAgo(1),
    messages: [
      ["user", "Would 6.6% win the margin back?"],
      [
        "bot",
        "Mostly. At **6.6%** margin recovers about **0.3 points** by Q4, but it puts you above two of the four banks.\n\n- Priya’s note capped risk at 6.5% for clients under $2M\n- Holding 6.4% keeps the lowest rate in the segment",
      ],
      ["user", "What if 6.6% applies only above $2M?"],
    ],
  },
  {
    id: "fork-math",
    anchor: "m4",
    title: "Show the math",
    state: "open",
    updatedAt: minutesAgo(38),
    messages: [
      ["user", "Break the 0.4 points into rate and funding."],
      [
        "bot",
        "Rate **+0.2**, funding cost **−0.6**, net **−0.4** points. Funding moved because term deposits repriced in May.",
      ],
    ],
  },
  {
    id: "fork-history",
    anchor: "m4",
    title: "Rate history",
    state: "archived",
    updatedAt: daysAgo(9),
    messages: [
      ["user", "When did we last move it?"],
      ["bot", "June, from 6.2% to 6.4%."],
    ],
  },
  {
    id: "fork-banks",
    anchor: "m6",
    title: "Which four banks?",
    state: "open",
    updatedAt: daysAgo(3),
    messages: [
      ["user", "Which four banks are in the table?"],
      ["bot", "The same four as Q2, as you decided on 1 October."],
    ],
  },
];

export function forkMessages(seed: ForkSeed): ThreadMessage[] {
  return seed.messages.map(([role, text], index) =>
    say(`${seed.id}-${index + 1}`, role, text, minutesAgo(30 - index), seed.id),
  );
}

export function forkEntry(seed: ForkSeed): MessageFork {
  return {
    chatId: seed.id,
    title: seed.title,
    replies: seed.messages.length,
    live: Boolean(seed.live),
    unread: false,
    state: seed.state,
    summary: seed.summary ?? null,
    createdAt: seed.updatedAt,
  };
}

export function forkChat(seed: ForkSeed): ChatSummary {
  return {
    id: seed.id,
    title: seed.title,
    start: "withContext",
    summary: null,
    archived: seed.state === "archived",
    live: Boolean(seed.live),
    unread: false,
    anchorItemId: seed.anchor,
    updatedAt: seed.updatedAt,
  };
}

/** The Conversation, with each message's forks and an added fork's summary attached, as the
 * engine's transcript serves them. */
export function conversationWithForks(seeds: readonly ForkSeed[]): ThreadMessage[] {
  const base = [
    say(
      "m1",
      "user",
      "Dana wants the Q3 pricing deck refreshed with Q2 actuals before Thursday.",
      minutesAgo(70),
    ),
    say(
      "m2",
      "bot",
      "Draft 2 is ready. Q2 actuals are on slides 1–6; margin by segment goes on slide 7 next.",
      minutesAgo(69),
    ),
    say("m3", "user", "What did we land on for the small-business rate?", minutesAgo(50)),
    say(
      "m4",
      "bot",
      "**6.4%**, set on 28 September after Priya’s risk note. Funding cost rose 0.6 points in Q2 while the rate moved 0.2, so small-business margin is down **0.4 points**.",
      minutesAgo(49),
    ),
    say("m5", "user", "Ok. Send draft 2 to Dana when the competitor table is in.", minutesAgo(45)),
    say(
      "m6",
      "bot",
      "Will do. I’m pulling public rate sheets for the four banks now and will send it once the table is on slide 9.",
      minutesAgo(44),
    ),
  ];
  return base.map((message) => {
    const mine = seeds.filter((seed) => seed.anchor === message.id);
    if (!mine.length) return message;
    return {
      ...message,
      forks: mine.map(forkEntry),
      blocks: [
        ...message.blocks,
        ...mine.flatMap((seed) =>
          seed.state === "added" && seed.summary
            ? [
                {
                  kind: "fork_summary" as const,
                  forkId: seed.id,
                  anchorItemId: message.id,
                  title: seed.title,
                  summary: seed.summary,
                },
              ]
            : [],
        ),
      ],
    };
  });
}
