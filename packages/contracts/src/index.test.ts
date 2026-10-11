import { describe, expect, it } from "vitest";
import {
  appContract,
  canReactToThreadMessage,
  MessageBlock,
  ProductEventType,
  RunSchema,
} from "./index.js";

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

  it("limits reactions to persisted non-channel messages", () => {
    expect(
      canReactToThreadMessage({ id: "message-1", blocks: [{ kind: "text", text: "hi" }] }),
    ).toBe(true);
    expect(
      canReactToThreadMessage({ id: "subagent:agent-1", blocks: [{ kind: "text", text: "hi" }] }),
    ).toBe(false);
    expect(
      canReactToThreadMessage({
        id: "message-2",
        blocks: [
          {
            kind: "channel_message",
            provider: "sendblue",
            channelId: "channel-1",
            fromAddress: "+15555550100",
            fromLabel: "Pat",
            text: "hi",
          },
        ],
      }),
    ).toBe(false);
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
    expect(ProductEventType.options).toContain("thread.message.created");
  });

  it("accepts bot-to-bot runs in thread snapshots", () => {
    const run = {
      id: "run-1",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "running",
      trigger: "bot_message",
      routineId: null,
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: "2026-08-26T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-08-26T00:00:00.000Z",
    };

    expect(RunSchema.safeParse(run).success).toBe(true);
    expect(RunSchema.safeParse({ ...run, trigger: "webhook" }).success).toBe(true);
  });

  it("rejects oversized chart data wherever it is embedded", () => {
    const rows = Array.from({ length: 5_001 }, (_, index) => index);

    expect(
      MessageBlock.safeParse({ kind: "chart", name: "outer", spec: {}, data: rows }).success,
    ).toBe(false);
    expect(
      MessageBlock.safeParse({
        kind: "chart",
        name: "spec",
        spec: { data: rows },
        data: [],
      }).success,
    ).toBe(false);
    expect(
      MessageBlock.safeParse({
        kind: "chart",
        name: "marks",
        spec: { marks: [{ data: rows }] },
        data: [],
      }).success,
    ).toBe(false);
    expect(
      MessageBlock.safeParse({
        kind: "chart",
        name: "combined",
        spec: { marks: [{ data: rows.slice(0, 2_500) }] },
        data: rows.slice(0, 2_501),
      }).success,
    ).toBe(false);
  });
});
