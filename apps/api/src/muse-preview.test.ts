import {
  AskSchema,
  FeedSchema,
  FollowedTopicSchema,
  GoalSchema,
  IdeaSchema,
  ThreadMessagePageSchema,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { musePreview } from "./muse-preview.js";

const botId = "bot-preview";

describe("musePreview", () => {
  it("serves data that matches the Muse contracts", () => {
    const goals = musePreview.goals.list(botId);
    expect(goals.length).toBeGreaterThan(0);
    for (const goal of goals) {
      GoalSchema.parse(goal);
      ThreadMessagePageSchema.parse(musePreview.goals.log(goal.id));
    }
    AskSchema.array().parse(musePreview.asks.list(botId));
    FeedSchema.parse(musePreview.feed.list(botId));
    IdeaSchema.array().parse(musePreview.ideas.list(botId));
    FollowedTopicSchema.array().parse(musePreview.topics.list(botId));
  });

  it("closes a Proposal everywhere when its Ask is answered", () => {
    const proposalAsk = musePreview.asks.list(botId).find((ask) => ask.kind === "proposal");
    expect(proposalAsk?.goalId).toBeTruthy();
    const before = musePreview.asks.count(botId).count;

    musePreview.asks.answer({ askId: proposalAsk!.id, answer: "accept" });

    const goal = musePreview.goals.get(proposalAsk!.goalId!);
    expect(goal.openProposal).toBeNull();
    expect(goal.tasks.map((item) => item.title)).toContain("Join a Saturday conversation club");
    expect(musePreview.asks.count(botId).count).toBe(before - 1);
    expect(musePreview.feed.list(botId).asks.some((ask) => ask.id === proposalAsk!.id)).toBe(false);
  });
});
