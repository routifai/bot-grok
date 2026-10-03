import { expect, it } from "vitest";
import { deriveConnectionStatus } from "./connectionStatus";

it("is connecting before any poll has ever landed", () => {
  expect(deriveConnectionStatus({ status: "loading" })).toBe("connecting");
  expect(deriveConnectionStatus(undefined)).toBe("connecting");
});

it("is connected once a poll comes back ready", () => {
  expect(deriveConnectionStatus({ status: "ready" })).toBe("connected");
});

it("is connected when a poll answers NOT_IMPLEMENTED — the server answered", () => {
  expect(deriveConnectionStatus({ status: "unavailable" })).toBe("connected");
});

it("is connecting while every given poll is loading or failing", () => {
  expect(deriveConnectionStatus({ status: "error" }, { status: "loading" })).toBe("connecting");
});

it("is connected if any one of several polls has landed", () => {
  expect(deriveConnectionStatus({ status: "error" }, { status: "ready" })).toBe("connected");
});
