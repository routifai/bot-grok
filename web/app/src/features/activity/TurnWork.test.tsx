// @vitest-environment jsdom

import { act, memo } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TurnWorkProvider, useDrawnByStrip, useTurnStrip } from "./TurnWork";
import type { TranscriptWork, TurnWork } from "./workPlan";

const unmounts: Array<() => void> = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

const turn = (anchorId: string, text: string, last = false): TurnWork => ({
  anchorId,
  plan: [{ text, status: "doing", added: false }],
  helpers: [],
  startedAt: 1_000,
  endedAt: 2_000,
  last,
});

const work = (turns: TurnWork[], drawn: string[] = []): TranscriptWork => ({
  turns: new Map(turns.map((found) => [found.anchorId, found])),
  drawn: new Set(drawn),
});

it("re-renders only the message whose strip a transcript update touched", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const renders: Record<string, number> = {};
  const seen: Record<string, string | undefined> = {};
  const Message = memo(function Message({ id }: { id: string }) {
    const strip = useTurnStrip(id);
    const drawn = useDrawnByStrip();
    renders[id] = (renders[id] ?? 0) + 1;
    seen[id] = `${strip?.turn.plan?.[0]?.text}|${strip?.turn.live}|${drawn(id, 0)}`;
    return null;
  });
  const root = createRoot(document.createElement("div"));
  unmounts.push(() => act(() => root.unmount()));
  const render = (next: TranscriptWork, running = false) =>
    act(async () =>
      root.render(
        <TurnWorkProvider work={next} running={running}>
          <Message id="a" />
          <Message id="b" />
        </TurnWorkProvider>,
      ),
    );

  await render(work([turn("a", "Read"), turn("b", "Write", true)], ["a:0"]));
  expect(seen).toEqual({ a: "Read|false|true", b: "Write|false|false" });
  expect(renders).toEqual({ a: 1, b: 1 });

  // Rebuilt from the transcript: new objects, the same work for "a"; "b"'s plan moved on.
  await render(work([turn("a", "Read"), turn("b", "Check", true)], ["a:0"]));
  expect(seen.b).toBe("Check|false|false");
  expect(renders).toEqual({ a: 1, b: 2 });

  // The newest reply starts running: only its strip is lit.
  await render(work([turn("a", "Read"), turn("b", "Check", true)], ["a:0"]), true);
  expect(seen.b).toBe("Check|true|false");
  expect(renders).toEqual({ a: 1, b: 3 });

  // A streamed update with nothing new for either strip renders neither.
  await render(work([turn("a", "Read"), turn("b", "Check", true)], ["a:0"]), true);
  expect(renders).toEqual({ a: 1, b: 3 });
});
