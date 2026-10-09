import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { relayScreenUrlFor, resolveScreenPublicUrl, screenUrlWithToken } from "./computer-spec.js";
import { createScreenRelay, parseScreenRoute } from "./screen-relay.js";

const TOKEN = "view-token_123";

describe("screen relay", () => {
  let gateway: http.Server;
  let gatewayPort: number;
  let upgrades: Array<{ url: string | undefined; headers: http.IncomingHttpHeaders }>;
  let relayServer: http.Server;
  let relayPort: number;
  let resolvedPorts: string[];
  let requestedTargets: Array<[string, string]>;
  const sockets = new Set<import("node:net").Socket>();

  beforeEach(async () => {
    upgrades = [];
    resolvedPorts = ["6080"];
    requestedTargets = [];
    gateway = http.createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(`asset:${req.url}`);
    });
    gateway.on("upgrade", (req, socket) => {
      upgrades.push({ url: req.url, headers: req.headers });
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
      socket.on("data", (data) => socket.write(Buffer.concat([Buffer.from("echo:"), data])));
    });
    for (const server of [gateway]) server.on("connection", (s) => sockets.add(s));
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    gatewayPort = (gateway.address() as AddressInfo).port;

    const relay = createScreenRelay({
      registeredPorts: async (id) => (id === "comp1" ? resolvedPorts : []),
      resolveTarget: async (id, port) => {
        requestedTargets.push([id, port]);
        return { host: "127.0.0.1", port: gatewayPort };
      },
    });
    relayServer = http.createServer(async (req, res) => {
      const response = await relay.http(
        new Request(`http://relay.test${req.url}`, { method: req.method }),
      );
      res.statusCode = response.status;
      for (const [key, value] of response.headers) res.setHeader(key, value);
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    relayServer.on("upgrade", (req, socket, head) => void relay.upgrade(req, socket, head));
    relayServer.on("connection", (s) => sockets.add(s));
    await new Promise<void>((resolve) => relayServer.listen(0, "127.0.0.1", resolve));
    relayPort = (relayServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const s of sockets) s.destroy();
    sockets.clear();
    await Promise.all([
      new Promise((resolve) => relayServer.close(resolve)),
      new Promise((resolve) => gateway.close(resolve)),
    ]);
  });

  const get = (path: string) =>
    fetch(`http://127.0.0.1:${relayPort}${path}`, { redirect: "manual" });

  function connectSocket(path: string, extra = "") {
    return new Promise<{ status: string; echo: () => Promise<string> }>((resolve) => {
      const req = http.request({
        host: "127.0.0.1",
        port: relayPort,
        path,
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
          cookie: "secret=1",
          authorization: "Bearer nope",
        },
      });
      req.on("upgrade", (res, socket) =>
        resolve({
          status: `${res.statusCode}`,
          echo: () =>
            new Promise((done) => {
              socket.once("data", (data) => {
                socket.destroy();
                done(data.toString());
              });
              socket.write(`ping${extra}`);
            }),
        }),
      );
      req.on("response", (res) => {
        res.resume();
        resolve({ status: `${res.statusCode}`, echo: async () => "" });
      });
      req.on("error", () => resolve({ status: "closed", echo: async () => "" }));
      req.end();
    });
  }

  it("serves the entry page only with a token and streams the gateway response", async () => {
    const entry = `/screens/comp1/embed.html?path=${encodeURIComponent(`websockify?token=${TOKEN}`)}`;
    const ok = await get(entry);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("text/html");
    expect(await ok.text()).toContain("/embed.html?path=");
    expect((await get("/screens/comp1/embed.html")).status).toBe(401);
    expect((await get("/screens/comp1/embed.html?path=websockify%3Ftoken%3D..%2F")).status).toBe(
      401,
    );
  });

  it("proxies static assets from the registered Computer only", async () => {
    const asset = await get("/screens/comp1/core/rfb.js");
    expect(await asset.text()).toBe("asset:/core/rfb.js");
    expect(requestedTargets).toEqual([["comp1", "6080"]]);
    expect((await get("/screens/other/core/rfb.js")).status).toBe(404);
  });

  it("rejects traversal, encoded separators and non-GET methods", async () => {
    expect(parseScreenRoute("/screens/comp1/../x")).toBeUndefined();
    expect(parseScreenRoute("/screens/comp1/a%2fb/x")).toBeUndefined();
    expect(parseScreenRoute("/screens/co%2fmp/x")).toBeUndefined();
    expect(parseScreenRoute("/screens/comp1/a//b")).toBeUndefined();
    const post = await fetch(`http://127.0.0.1:${relayPort}/screens/comp1/core/rfb.js`, {
      method: "POST",
    });
    expect(post.status).toBe(405);
  });

  it("404s a Computer with no registered screen", async () => {
    resolvedPorts = [];
    expect((await get("/screens/comp1/core/rfb.js")).status).toBe(404);
  });

  it("forwards a websocket upgrade with a token, without client credentials", async () => {
    const socket = await connectSocket(`/screens/comp1/websockify?token=${TOKEN}&host=evil&port=1`);
    expect(socket.status).toBe("101");
    expect(await socket.echo()).toBe("echo:ping");
    expect(upgrades).toHaveLength(1);
    expect(upgrades[0]!.url).toBe(`/websockify?token=${TOKEN}`);
    expect(upgrades[0]!.headers.cookie).toBeUndefined();
    expect(upgrades[0]!.headers.authorization).toBeUndefined();
    expect(upgrades[0]!.headers.host).toBe(`127.0.0.1:${gatewayPort}`);
  });

  it("refuses a websocket without a token or for an unknown Computer", async () => {
    expect((await connectSocket("/screens/comp1/websockify")).status).toBe("401");
    expect((await connectSocket("/screens/comp1/websockify?token=bad%20token")).status).toBe("401");
    expect((await connectSocket(`/screens/nope/websockify?token=${TOKEN}`)).status).toBe("404");
    expect((await connectSocket(`/screens/comp1/other?token=${TOKEN}`)).status).toBe("404");
    expect(upgrades).toHaveLength(0);
  });
});

describe("public screen URL", () => {
  it("normalizes the configured origin and ignores junk", () => {
    expect(resolveScreenPublicUrl("https://203-0-113-7.sslip.io/")).toBe(
      "https://203-0-113-7.sslip.io",
    );
    expect(resolveScreenPublicUrl("")).toBeUndefined();
    expect(resolveScreenPublicUrl(undefined)).toBeUndefined();
    expect(resolveScreenPublicUrl("ftp://x")).toBeUndefined();
    expect(resolveScreenPublicUrl("not a url")).toBeUndefined();
  });

  it("builds the relay entry URL with the view token in the socket path", () => {
    const url = screenUrlWithToken(relayScreenUrlFor("https://h.sslip.io", "abc123"), TOKEN);
    expect(url).toBe(
      `https://h.sslip.io/screens/abc123/embed.html?path=websockify%3Ftoken%3D${TOKEN}`,
    );
  });
});
