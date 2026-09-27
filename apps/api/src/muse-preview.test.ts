import {
  FollowedTopicSchema,
  GoalSchema,
  IdeaSchema,
  PostSchema,
  ThreadMessagePageSchema,
} from "@aiden/contracts";
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
    PostSchema.array().parse(musePreview.feed.list(botId).posts);
    IdeaSchema.array().parse(musePreview.ideas.list(botId));
    FollowedTopicSchema.array().parse(musePreview.topics.list(botId));
  });

  it("accepts a Proposal, replacing the Goal's plan with the proposed tasks", () => {
    const goal = musePreview.goals.list(botId).find((candidate) => candidate.openProposal);
    expect(goal?.openProposal).toBeTruthy();

    const updated = musePreview.goals.acceptProposal(goal!.openProposal!.id);

    expect(updated.openProposal).toBeNull();
    expect(updated.tasks.map((item) => item.title)).toContain("Join a Saturday conversation club");
  });
});
