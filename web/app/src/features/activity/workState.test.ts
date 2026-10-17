import { expect, it } from "vitest";
import { helper } from "./activityTestKit";
import type { TurnStatus } from "./workState";
import { deriveWorkState, IDLE_TURN } from "./workState";

const START = Date.parse("2026-10-17T10:00:00.000Z");
const turnAt = START + 30_000;
const running = (overrides: Partial<TurnStatus> = {}) => ({ ...IDLE_TURN, ...overrides });
const derive = (
  turn: TurnStatus,
  { sending = false, stopping = false, activities = [] as ReturnType<typeof helper>[] } = {},
) => deriveWorkState({ turn, sending, stopping, activities, turnStartedAt: turnAt });
const helperRunning = helper("h1", {
  status: "in_progress",
  startedAt: new Date(START).toISOString(),
  finishedAt: null,
});

it("is idle with nothing running, and counts nothing", () => {
  expect(derive(IDLE_TURN)).toEqual({
    phase: "idle",
    running: false,
    turnRunning: false,
    since: null,
    cancelled: false,
  });
});

it("runs while the turn runs or a reply is expected, from the turn's start", () => {
  expect(derive(running({ running: true }))).toMatchObject({
    phase: "running",
    turnRunning: true,
    since: turnAt,
  });
  expect(derive(running({ awaiting: true })).since).toBe(turnAt);
});

it("runs while a Helper runs after the turn ended, from the Helper's start", () => {
  const state = derive(IDLE_TURN, { activities: [helperRunning] });
  expect(state).toMatchObject({
    phase: "running",
    running: true,
    turnRunning: false,
    since: START,
  });
});

it("never counts a file's studio turn", () => {
  const studio = helper("s1", { ...helperRunning, source: "studio" });
  expect(derive(IDLE_TURN, { activities: [studio] }).running).toBe(false);
});

it("says sending, then stopping, over whatever runs", () => {
  expect(derive(IDLE_TURN, { sending: true })).toMatchObject({
    phase: "sending",
    running: true,
    turnRunning: true,
  });
  expect(derive(running({ running: true }), { sending: true, stopping: true }).phase).toBe(
    "stopping",
  );
});

it("stops at once when a Stop landed, though the engine's turn and its Helpers are still ending", () => {
  const stopped = derive(running({ running: true, stopped: true, cancelled: true }), {
    activities: [helperRunning],
  });
  expect(stopped).toEqual({
    phase: "idle",
    running: false,
    turnRunning: false,
    since: null,
    cancelled: true,
  });
});
