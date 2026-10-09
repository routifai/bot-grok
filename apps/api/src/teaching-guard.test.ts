import { describe, expect, it, vi } from "vitest";

const listOmnigentTaughtSkills = vi.fn();
vi.mock("@nova/adapters", () => ({ listOmnigentTaughtSkills }));
vi.mock("./engine-client.js", () => ({
  engineComputerClient: () => ({ baseUrl: "http://omnigent.test" }),
  engineSessionOf: vi.fn(async () => ({ email: "me@example.test", sessionId: "sess-1" })),
}));

const { assertTeachingSendAllowed } = await import("./teaching-guard.js");

const actor = { userId: "user-1", spaceId: "space-1" } as never;

describe("assertTeachingSendAllowed", () => {
  it("holds sends while the person is teaching and fails open when the engine is down", async () => {
    listOmnigentTaughtSkills.mockResolvedValueOnce([{ status: "recording" }]);
    await expect(assertTeachingSendAllowed({} as never, actor, "bot-1")).rejects.toThrow(
      "Stop teaching first",
    );
    listOmnigentTaughtSkills.mockRejectedValueOnce(new Error("down"));
    await expect(assertTeachingSendAllowed({} as never, actor, "bot-1")).resolves.toBeUndefined();
    listOmnigentTaughtSkills.mockResolvedValueOnce([{ status: "draft" }]);
    await expect(assertTeachingSendAllowed({} as never, actor, "bot-1")).resolves.toBeUndefined();
  });
});
