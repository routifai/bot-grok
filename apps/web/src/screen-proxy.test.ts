import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNovncTarget, safeProxyHeaders, watchScreenAuthorization } from "./screen-proxy.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("screen proxy", () => {
  it("rejects legacy URLs without contacting the API", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(
      await resolveNovncTarget("/novnc/old/view/token/embed.html", "secret", "http://api.example"),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("checks each request and fails closed on revocation or API failure", async () => {
    const target = {
      protocol: "http:",
      hostname: "127.0.0.1",
      port: 49152,
      path: "/websockify",
      interactive: false,
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(target))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetch);
    const resolve = () =>
      resolveNovncTarget("/novnc/session/view/token/websockify", "secret", "http://api.example", 0);
    expect(await resolve()).toEqual(target);
    expect(await resolve()).toBeNull();
    expect(await resolve()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: { authorization: "Bearer secret" },
    });
  });
  it("retries an unavailable API briefly but never retries a denial", async () => {
    const target = {
      protocol: "http:",
      hostname: "127.0.0.1",
      port: 49152,
      path: "/websockify",
      interactive: false,
    };
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("restarting"))
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(Response.json(target));
    vi.stubGlobal("fetch", fetch);
    const url = "/novnc/session/view/token/websockify";
    expect(await resolveNovncTarget(url, "secret", "http://api.example", 2, 1)).toEqual(target);
    expect(fetch).toHaveBeenCalledTimes(3);
    fetch.mockReset().mockResolvedValue(new Response(null, { status: 403 }));
    expect(await resolveNovncTarget(url, "secret", "http://api.example", 2, 1)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps an open stream through a short API outage and closes it after the grace", async () => {
    vi.useFakeTimers();
    const revoke = vi.fn();
    let answer: boolean | "unavailable" = "unavailable";
    watchScreenAuthorization(async () => answer, revoke, 3_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(revoke).not.toHaveBeenCalled();
    answer = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(revoke).not.toHaveBeenCalled();
    answer = "unavailable";
    await vi.advanceTimersByTimeAsync(6_000);
    expect(revoke).toHaveBeenCalledTimes(1);
  });
  it("fails closed for a malformed authority response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ hostname: "screen.example", port: "443" })),
    );
    expect(
      await resolveNovncTarget(
        "/novnc/session/view/token/vnc.html",
        "secret",
        "http://api.example",
      ),
    ).toBeNull();
  });

  it("closes an active stream on revocation and stops checking closed streams", async () => {
    vi.useFakeTimers();
    const check = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const revoke = vi.fn();
    watchScreenAuthorization(check, revoke);
    await vi.advanceTimersByTimeAsync(1000);
    expect(revoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(revoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(check).toHaveBeenCalledTimes(2);
    const stop = watchScreenAuthorization(check, revoke);
    stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(check).toHaveBeenCalledTimes(2);
  });
  it("closes a stream when authorization fails unexpectedly", async () => {
    vi.useFakeTimers();
    const revoke = vi.fn();
    watchScreenAuthorization(async () => {
      throw new Error("unavailable");
    }, revoke);
    await vi.advanceTimersByTimeAsync(1000);
    expect(revoke).toHaveBeenCalledTimes(1);
  });
  it("does not forward application credentials", () => {
    expect(
      safeProxyHeaders({
        host: "app.example",
        cookie: "session=secret",
        authorization: "Bearer secret",
        "proxy-authorization": "Basic secret",
        upgrade: "websocket",
        "sec-websocket-key": "key",
      }),
    ).toEqual({ upgrade: "websocket", "sec-websocket-key": "key" });
  });

  it("does not forward HTTP/2 pseudo-headers to the HTTP/1 upstream", () => {
    expect(
      safeProxyHeaders({
        ":method": "GET",
        ":path": "/novnc/embed.html",
        ":authority": "localhost:5173",
        ":scheme": "https",
        upgrade: "websocket",
        "sec-websocket-key": "key",
      }),
    ).toEqual({ upgrade: "websocket", "sec-websocket-key": "key" });
  });
});
