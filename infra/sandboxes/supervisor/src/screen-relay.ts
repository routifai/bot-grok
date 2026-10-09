import type { IncomingMessage } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

/**
 * Relay for a Computer's noVNC screen, for deployments where the supervisor's Computers sit on
 * private Docker networks that only the supervisor can reach. The browser-side proxy talks to
 * the supervisor's public host (behind Caddy); the supervisor forwards to the Computer's own
 * screen gateway. The upstream host is never taken from the request: it comes from the
 * supervisor's own registry and Docker state, through `ScreenRelayDeps`.
 *
 * Auth: the websocket and the entry page need the per-view token that the in-container
 * websockify gateway also validates (its token file is the authority, including takeover
 * control tokens, which the supervisor does not store). Static noVNC assets carry no token
 * (the browser fetches them as plain sub-resources) and hold nothing secret.
 */
export interface ScreenRelayDeps {
  /** Gateway ports of the screens registered for a Computer; empty when none is known. */
  registeredPorts(computerId: string): Promise<string[]>;
  /** Where the Computer's gateway port is reachable from the supervisor. */
  resolveTarget(
    computerId: string,
    port: string,
  ): Promise<{ host: string; port: number } | undefined>;
}

const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const SAFE_TOKEN = /^[a-zA-Z0-9_-]{1,64}$/;
const SAFE_ASSET = /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;
const ENTRY_PAGES = new Set(["embed.html", "vnc.html"]);
const HEADER_TIMEOUT_MS = 15_000;
const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "last-modified"];
const DROPPED_UPGRADE_HEADERS = new Set([
  "host",
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

export interface ScreenRoute {
  id: string;
  rest: string;
  search: URLSearchParams;
}

export function parseScreenRoute(rawUrl: string | undefined): ScreenRoute | undefined {
  if (!rawUrl) return undefined;
  let url: URL;
  try {
    url = new URL(rawUrl, "http://supervisor.invalid");
  } catch {
    return undefined;
  }
  const match = url.pathname.match(/^\/screens\/([^/]+)\/(.+)$/);
  if (!match || !SAFE_ID.test(match[1]!)) return undefined;
  const rest = match[2]!;
  // Percent-encoding is not accepted at all, so no encoded traversal or separators can slip in.
  if (!SAFE_ASSET.test(rest) || rest.split("/").some((part) => part === "." || part === ".."))
    return undefined;
  return { id: match[1]!, rest, search: url.searchParams };
}

/** The view token, as noVNC puts it: `?path=websockify?token=...` on the entry page. */
function entryToken(search: URLSearchParams) {
  const nested = search.get("path");
  const token = nested ? new URLSearchParams(nested.split("?")[1] ?? "").get("token") : null;
  return token && SAFE_TOKEN.test(token) ? token : undefined;
}

function socketToken(search: URLSearchParams) {
  const token = search.get("token");
  return token && SAFE_TOKEN.test(token) ? token : undefined;
}

type Resolved =
  | { ok: true; host: string; port: number; path: string }
  | { ok: false; status: number; error: string };

async function resolveRoute(
  deps: ScreenRelayDeps,
  route: ScreenRoute,
  kind: "http" | "upgrade",
): Promise<Resolved> {
  let path: string;
  if (kind === "upgrade") {
    if (route.rest !== "websockify") return { ok: false, status: 404, error: "not found" };
    const token = socketToken(route.search);
    if (!token) return { ok: false, status: 401, error: "screen token required" };
    path = `/websockify?token=${token}`;
  } else if (ENTRY_PAGES.has(route.rest)) {
    if (!entryToken(route.search))
      return { ok: false, status: 401, error: "screen token required" };
    path = `/${route.rest}?${route.search.toString()}`;
  } else {
    path = `/${route.rest}`;
  }
  const ports = await deps.registeredPorts(route.id);
  const port = ports[0];
  if (!port) return { ok: false, status: 404, error: "screen not found" };
  const target = await deps.resolveTarget(route.id, port).catch(() => undefined);
  if (!target) return { ok: false, status: 404, error: "screen not found" };
  return { ok: true, ...target, path };
}

export function createScreenRelay(deps: ScreenRelayDeps) {
  async function http(request: Request): Promise<Response> {
    const route = parseScreenRoute(new URL(request.url).pathname + new URL(request.url).search);
    if (!route) return Response.json({ error: "not found" }, { status: 404 });
    if (request.method !== "GET" && request.method !== "HEAD")
      return Response.json({ error: "method not allowed" }, { status: 405 });
    const resolved = await resolveRoute(deps, route, "http");
    if (!resolved.ok) return Response.json({ error: resolved.error }, { status: resolved.status });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS);
    request.signal.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      const upstream = await fetch(`http://${resolved.host}:${resolved.port}${resolved.path}`, {
        method: request.method,
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: request.headers.get("accept") ?? "*/*", "accept-encoding": "identity" },
      });
      clearTimeout(timer);
      const headers = new Headers();
      for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value) headers.set(name, value);
      }
      // The body streams through untouched; nothing is read into memory here.
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch {
      clearTimeout(timer);
      return Response.json({ error: "screen unavailable" }, { status: 502 });
    }
  }

  function reject(socket: Duplex, status: number, error: string) {
    if (socket.writable) {
      socket.write(`HTTP/1.1 ${status} ${error}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    }
    socket.destroy();
  }

  /** Handle an HTTP `upgrade` event. Anything but a valid screen websocket is closed. */
  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on("error", () => socket.destroy());
    const route = parseScreenRoute(req.url);
    if (!route || (req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
      reject(socket, 404, "Not Found");
      return;
    }
    const resolved = await resolveRoute(deps, route, "upgrade").catch(
      (): Resolved => ({ ok: false, status: 502, error: "Bad Gateway" }),
    );
    if (!resolved.ok) {
      reject(socket, resolved.status, resolved.error);
      return;
    }
    const upstream = net.connect({ host: resolved.host, port: resolved.port });
    upstream.setNoDelay(true);
    upstream.on("error", () => {
      if (!socket.destroyed && socket.writable && !upstream.readableLength) {
        reject(socket, 502, "Bad Gateway");
      }
      socket.destroy();
    });
    upstream.once("connect", () => {
      const lines = [`GET ${resolved.path} HTTP/1.1`, `Host: ${resolved.host}:${resolved.port}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i]!;
        if (DROPPED_UPGRADE_HEADERS.has(name.toLowerCase())) continue;
        lines.push(`${name}: ${req.rawHeaders[i + 1]!.replace(/[\r\n]/g, "")}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    const close = () => {
      socket.destroy();
      upstream.destroy();
    };
    socket.once("close", close);
    upstream.once("close", close);
  }

  return { http, upgrade };
}
