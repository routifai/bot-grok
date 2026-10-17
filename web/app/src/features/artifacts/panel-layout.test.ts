import { expect, it } from "vitest";
import { artifactPanelLayout, CONVERSATION_MIN_W } from "./panel-layout";

it("puts a deck beside the Conversation on a wide window, leaving the Conversation room", () => {
  const layout = artifactPanelLayout(1358, { wide: true });
  expect(layout).toEqual({ mode: "split", width: 805 });
  if (layout.mode === "split") expect(1358 - 16 - layout.width).toBeGreaterThanOrEqual(400);
});

it("caps the panel on a very wide window", () => {
  expect(artifactPanelLayout(2400, { wide: true })).toEqual({ mode: "split", width: 960 });
  expect(artifactPanelLayout(2400, {})).toEqual({ mode: "split", width: 640 });
});

it("editing takes all the room the Conversation can spare, and never more", () => {
  expect(artifactPanelLayout(1358, { wide: true, expanded: true })).toEqual({
    mode: "split",
    width: 1358 - 16 - CONVERSATION_MIN_W,
  });
  expect(artifactPanelLayout(2600, { wide: true, expanded: true })).toEqual({
    mode: "split",
    width: 1600,
  });
});

it("becomes a sheet over the Conversation when both cannot fit", () => {
  // About a 1000px window: a deck would leave the Conversation a sliver.
  expect(artifactPanelLayout(888, { wide: true })).toEqual({ mode: "overlay" });
  expect(artifactPanelLayout(975, { wide: true })).toEqual({ mode: "overlay" });
  expect(artifactPanelLayout(976, { wide: true })).toEqual({ mode: "split", width: 560 });
  // A plain file fits beside it a little sooner.
  expect(artifactPanelLayout(888, {})).toEqual({ mode: "split", width: 401 });
  expect(artifactPanelLayout(700, {})).toEqual({ mode: "overlay" });
});
