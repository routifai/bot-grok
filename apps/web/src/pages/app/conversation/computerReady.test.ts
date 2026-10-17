import type { ComputerStatus } from "@superchat/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pollingComputerFeed } from "./computerReady";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const status = (state: ComputerStatus["state"]) => ({ state }) as ComputerStatus;

it("reads the Computer's status only while a step listens, at once and then on an interval", async () => {
  const read = vi.fn(async () => status("booting"));
  const feed = pollingComputerFeed(read, 1_000);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(read).not.toHaveBeenCalled();

  const seen: Array<ComputerStatus | null> = [];
  const unsubscribe = feed.subscribe((next) => seen.push(next));
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  expect(feed.current()?.state).toBe("booting");

  read.mockResolvedValue(status("running"));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(seen.map((next) => next?.state)).toEqual(["booting", "running"]);

  unsubscribe();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(read).toHaveBeenCalledTimes(2);
});

it("keeps what it last saw when a read fails", async () => {
  const read = vi.fn<() => Promise<ComputerStatus | null>>();
  read.mockResolvedValueOnce(status("running")).mockRejectedValue(new Error("down"));
  const feed = pollingComputerFeed(read, 1_000);
  const unsubscribe = feed.subscribe(() => undefined);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(feed.current()?.state).toBe("running");
  unsubscribe();
});
