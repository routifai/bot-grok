import type { PrismaClient } from "@aiden/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchActivities } from "./activities.js";

const env = { OMNIGENT_URL: "http://engine.test", OMNIGENT_PROXY_SECRET: "proxy" };
const actor = { userId: "user-1", spaceId: "space-1" } as never;
const deps = {
  prisma: {
    bot: { findFirst: vi.fn(async () => ({ id: "bot-1" })) },
    user: { findUnique: vi.fn(async () => ({ email: "p@example.test", timezone: null })) },
    omnigentSession: { findUnique: vi.fn(async () => ({ omnigentSessionId: "sess-1" })) },
  } as unknown as PrismaClient,
};

const sse = (...frames: Array<Record<string, unknown>>) =>
  new Response(frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

afterEach(() => vi.unstubAllGlobals());

describe("watchActivities", () => {
  it("relays the engine's change signal and heartbeats for the Muse's Super Chat", async () => {
    const fetchMock = vi.fn(async () =>
      sse({ type: "activities.changed" }, { type: "session.heartbeat" }, { type: "other" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const frames = [];
    for await (const frame of watchActivities(deps, actor, { botId: "bot-1" }, undefined, env)) {
      frames.push(frame);
    }
    expect(frames).toEqual([{ type: "changed" }, { type: "heartbeat" }]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://engine.test/v1/sessions/sess-1/activities/stream",
    );
  });

  it("treats a closed tab as the normal end of the watch", async () => {
    const abort = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        abort.abort();
        throw new DOMException("aborted", "AbortError");
      }),
    );
    const frames = [];
    for await (const frame of watchActivities(deps, actor, { botId: "bot-1" }, abort.signal, env)) {
      frames.push(frame);
    }
    expect(frames).toEqual([]);
  });
});
