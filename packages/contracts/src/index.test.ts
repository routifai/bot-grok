import { describe, expect, it } from "vitest";
import { appContract, MessageBlock } from "./index.js";

describe("contracts", () => {
  it("accepts structured live activity progress", () => {
    expect(MessageBlock.parse({ kind: "progress", text: "Using browser", activity: true })).toEqual(
      { kind: "progress", text: "Using browser", activity: true },
    );
  });

  it("accepts optional persisted duration only on valid steps blocks", () => {
    expect(
      MessageBlock.parse({
        kind: "steps",
        steps: [{ label: "Run tests", count: 1 }],
        durationMs: 103_000,
      }),
    ).toMatchObject({ durationMs: 103_000 });
    expect(MessageBlock.safeParse({ kind: "steps", steps: [], durationMs: -1 }).success).toBe(
      false,
    );
  });

  it("exposes the product rpc surface", () => {
    expect(appContract.me).toBeTruthy();
    expect(appContract.bots.list).toBeTruthy();
    expect(appContract.chats.transcript).toBeTruthy();
    expect(appContract.engineModels).toBeTruthy();
    expect(appContract.automations).toBeTruthy();
    expect(appContract.approvals).toBeTruthy();
    expect("bootstrap" in appContract).toBe(false);
    expect("threads" in appContract).toBe(false);
    expect("spaces" in appContract).toBe(false);
  });
});
