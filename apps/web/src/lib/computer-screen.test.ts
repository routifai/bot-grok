import { afterEach, describe, expect, it, vi } from "vitest";
import {
  embeddableScreenUrl,
  loadComputerScreen,
  screenIframeSandbox,
  screenLinkKey,
  screenUrlStillFresh,
  shareInflight,
} from "./computer-screen";

describe("computer screen requests", () => {
  it("shows connection failures and lets a successful retry clear them", async () => {
    const commit = vi.fn();
    const options = {
      isCurrent: () => true,
      commit,
      fallbackError: "Could not connect",
    };
    await loadComputerScreen({
      ...options,
      load: async () => {
        throw new Error("Control stream failed to start");
      },
    });
    expect(commit).toHaveBeenLastCalledWith({
      url: null,
      error: "Control stream failed to start",
    });

    await expect(
      loadComputerScreen({
        ...options,
        load: async () => ({ url: "https://screen.example/vnc.html" }),
      }),
    ).resolves.toBe("https://screen.example/vnc.html");
    expect(commit).toHaveBeenLastCalledWith({
      url: "https://screen.example/vnc.html",
      error: null,
    });
  });

  it.each(["success", "failure"])(
    "ignores a stale %s after a newer screen failure",
    async (outcome) => {
      let finish!: (screen: { url: string | null }) => void;
      let fail!: (error: Error) => void;
      const deferred = new Promise<{ url: string | null }>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      let current = 1;
      const commit = vi.fn();
      const stale = loadComputerScreen({
        load: () => deferred,
        isCurrent: () => current === 1,
        commit,
        fallbackError: "Could not connect",
      });
      current = 2;
      await loadComputerScreen({
        load: async () => {
          throw new Error("Latest connection failed");
        },
        isCurrent: () => current === 2,
        commit,
        fallbackError: "Could not connect",
      });
      if (outcome === "success") finish({ url: "https://stale.example/vnc.html" });
      else fail(new Error("Stale connection failed"));
      await expect(stale).resolves.toBeNull();
      expect(commit).toHaveBeenCalledExactlyOnceWith({
        url: null,
        error: "Latest connection failed",
      });
    },
  );

  it("uses the visible fallback for errors without a message", async () => {
    const commit = vi.fn();
    await loadComputerScreen({
      load: async () => Promise.reject(null),
      isCurrent: () => true,
      commit,
      fallbackError: "Could not connect",
    });
    expect(commit).toHaveBeenCalledExactlyOnceWith({ url: null, error: "Could not connect" });
  });
});

describe("embeddableScreenUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hides a local screen whose port does not match the page", () => {
    vi.stubGlobal("window", { location: { href: "http://localhost:5173/" } });
    expect(embeddableScreenUrl("http://127.0.0.1:6080/vnc.html")).toBeNull();
    expect(embeddableScreenUrl("http://localhost:6080/vnc.html")).toBeNull();
  });

  it("keeps a non-local screen even when the port differs", () => {
    vi.stubGlobal("window", { location: { href: "http://localhost:5173/" } });
    expect(embeddableScreenUrl("https://screen.example:6080/vnc.html")).toBe(
      "https://screen.example:6080/vnc.html",
    );
  });
});

describe("screenIframeSandbox", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allows scripts and pointer lock only for /novnc/ paths", () => {
    vi.stubGlobal("window", { location: { href: "http://localhost:5173/" } });
    expect(screenIframeSandbox("http://127.0.0.1:5173/novnc/vnc.html")).toBe(
      "allow-scripts allow-pointer-lock",
    );
    expect(screenIframeSandbox("http://127.0.0.1:5173/vnc.html")).toBeUndefined();
  });
});

describe("screenUrlStillFresh", () => {
  const now = 1_000_000_000_000;
  const link = (expiresAt: number, policy = "view") =>
    `http://127.0.0.1:5173/novnc/session/${policy}/${expiresAt}.abc/embed.html?autoconnect=true`;

  it("keeps a capability link that is well within its lifetime", () => {
    expect(screenUrlStillFresh(link(now + 30 * 60_000), now)).toBe(true);
    expect(screenUrlStillFresh(link(now + 30 * 60_000, "control"), now)).toBe(true);
  });

  it("refreshes a link that is about to expire or already expired", () => {
    expect(screenUrlStillFresh(link(now + 60_000), now)).toBe(false);
    expect(screenUrlStillFresh(link(now - 1), now)).toBe(false);
  });

  it("refreshes anything that is not a capability link", () => {
    expect(screenUrlStillFresh(null, now)).toBe(false);
    expect(screenUrlStillFresh("desktop://screen", now)).toBe(false);
  });
});

describe("screenLinkKey", () => {
  const live = { state: "running", controlHolder: "none", screenAvailable: true } as const;

  it("ignores the reconnect hop and bot control each run makes", () => {
    const key = screenLinkKey(live);
    expect(screenLinkKey({ ...live, state: "booting" })).toBe(key);
    expect(screenLinkKey({ ...live, controlHolder: "bot" })).toBe(key);
  });

  it("changes when the screen goes away or the person takes control", () => {
    const key = screenLinkKey(live);
    expect(screenLinkKey({ ...live, screenAvailable: false })).not.toBe(key);
    expect(screenLinkKey({ ...live, state: "suspended" })).not.toBe(key);
    expect(screenLinkKey({ ...live, controlHolder: "user" })).not.toBe(key);
  });
});

describe("shareInflight", () => {
  it("shares one run per key until it settles, and lets a forced run replace it", async () => {
    const inflight = new Map<string, Promise<string>>();
    let release: (value: string) => void = () => undefined;
    const start = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));
    const first = shareInflight(inflight, "bot", start);
    expect(shareInflight(inflight, "bot", start)).toBe(first);
    expect(start).toHaveBeenCalledTimes(1);
    const forced = shareInflight(inflight, "bot", () => Promise.resolve("forced"), true);
    expect(shareInflight(inflight, "bot", start)).toBe(forced);
    release("late");
    expect(await first).toBe("late");
    expect(await forced).toBe("forced");
    await Promise.resolve();
    expect(inflight.size).toBe(0);
    await shareInflight(inflight, "bot", () => Promise.resolve("again"));
    expect(inflight.size).toBe(0);
  });
  it("frees the key after a failure", async () => {
    const inflight = new Map<string, Promise<string>>();
    await expect(
      shareInflight(inflight, "bot", () => Promise.reject(new Error("x"))),
    ).rejects.toThrow();
    await Promise.resolve();
    expect(inflight.size).toBe(0);
  });
});
