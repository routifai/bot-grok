import { FollowedTopicSchema, IdeaSchema, PostSchema } from "@aiden/contracts";
import { describe, expect, it } from "vitest";
import { musePreview } from "./muse-preview.js";

describe("musePreview", () => {
  it("serves data that matches the Muse contracts", () => {
    expect(() => PostSchema.array().parse(musePreview.feed.list().posts)).not.toThrow();
    expect(() => IdeaSchema.array().parse(musePreview.ideas.list())).not.toThrow();
    expect(() => FollowedTopicSchema.array().parse(musePreview.topics.list())).not.toThrow();
  });
});
