// `GET /apps/<slug>`: a published mini app, served from Nova's own origin but locked into an
// opaque origin by the response headers (CSP `sandbox` without `allow-same-origin`), so the page
// can never read Nova cookies, storage or API. Every response of this route carries those headers.
import { createHmac } from "node:crypto";
import {
  fetchOmnigentPublishedApp,
  type OmnigentClientConfig,
  type OmnigentPublishAudience,
  recordOmnigentPublishedView,
} from "@nova/adapters";
import type { PrismaClient } from "@nova/db";
import type { Context, Hono } from "hono";

export interface PublishedAppViewer {
  userId: string;
  email: string;
}

export interface PublishedAppsDeps {
  prisma: Pick<PrismaClient, "user" | "member">;
  /** The signed-in viewer for this request, or null. */
  viewer: (c: Context) => Promise<PublishedAppViewer | null>;
  /** The engine connection, or undefined when Nova runs without one. */
  engine: () => OmnigentClientConfig | undefined;
  /** Keys the daily-rotating viewer hash salt (never stored, never the raw IP). */
  secret: string;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,94}$/;

/** Opaque origin, no network, no Nova cookies: scripts and inline styles run, nothing leaves. */
export const PUBLISHED_APP_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-modals; default-src 'none'; " +
  "script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; " +
  "img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; " +
  "connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

/** The headers every `/apps/<slug>` response carries, whatever its status. */
export function publishedAppHeaders(
  audience: OmnigentPublishAudience | null,
): Record<string, string> {
  return {
    "content-security-policy": PUBLISHED_APP_CSP,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cache-control": audience === "link" ? "public, no-cache" : "no-store",
  };
}

/** Same-day, same-network viewers collapse to one key; it changes every UTC day. */
export function anonymousViewerKey(secret: string, ip: string, userAgent: string, day: string) {
  const salt = createHmac("sha256", secret).update(`published-apps:${day}`).digest();
  const digest = createHmac("sha256", salt).update(`${ip}\n${userAgent}`).digest("hex");
  return `a:${digest.slice(0, 32)}`;
}

function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || c.req.header("x-real-ip") || "unknown";
}

function page(title: string, body: string, link?: { href: string; label: string }) {
  const a = link ? `<p><a href="${link.href}">${link.label}</a></p>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#faf9f7;color:#1c1b19}main{padding:24px;max-width:28rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:.25rem 0;color:#5a5852}a{color:inherit}</style></head><body><main><h1>${title}</h1><p>${body}</p>${a}</main></body></html>`;
}

async function canOpen(
  deps: PublishedAppsDeps,
  audience: OmnigentPublishAudience,
  ownerEmail: string,
  viewer: PublishedAppViewer | null,
): Promise<boolean> {
  if (audience === "link") return true;
  if (!viewer) return false;
  const owner = ownerEmail.toLowerCase();
  if (viewer.email.toLowerCase() === owner) return true;
  if (audience === "owner") return false;
  // org: the viewer belongs to an organization the owner also belongs to.
  const ownerUser = await deps.prisma.user.findFirst({
    where: { email: owner },
    select: { id: true },
  });
  if (!ownerUser) return false;
  const shared = await deps.prisma.member.findFirst({
    where: {
      userId: viewer.userId,
      organization: { members: { some: { userId: ownerUser.id } } },
    },
    select: { id: true },
  });
  return Boolean(shared);
}

export function mountPublishedApps(app: Hono, deps: PublishedAppsDeps) {
  const html = (
    status: 200 | 403 | 404,
    body: string | Uint8Array,
    audience: OmnigentPublishAudience | null,
  ) =>
    new Response(body as BodyInit, {
      status,
      headers: {
        ...publishedAppHeaders(status === 200 ? audience : null),
        "content-type": "text/html; charset=utf-8",
        "content-disposition": "inline",
      },
    });
  const notFound = () =>
    html(404, page("Not found", "This app does not exist or is no longer published."), null);

  app.on(["GET", "HEAD"], "/apps/:slug", async (c) => {
    const slug = c.req.param("slug");
    const engine = deps.engine();
    if (!engine || !SLUG.test(slug)) return notFound();
    let published: Awaited<ReturnType<typeof fetchOmnigentPublishedApp>>;
    try {
      published = await fetchOmnigentPublishedApp(engine, slug);
    } catch (error) {
      deps.onError?.(error);
      return html(404, page("Not available", "This app could not be loaded right now."), null);
    }
    if (!published) return notFound();
    const viewer = await deps.viewer(c);
    if (!(await canOpen(deps, published.audience, published.owner, viewer))) {
      return html(
        403,
        page(
          viewer ? "Not available to you" : "Private app",
          viewer
            ? "The owner has not shared this app with you."
            : "Sign in to see whether you can open this app.",
          viewer ? undefined : { href: "/sign-in", label: "Sign in" },
        ),
        null,
      );
    }
    const isOwner = viewer?.email.toLowerCase() === published.owner.toLowerCase();
    if (c.req.method === "GET" && !isOwner) {
      const now = (deps.now ?? (() => new Date()))();
      const key = viewer
        ? `u:${viewer.userId}`
        : anonymousViewerKey(
            deps.secret,
            clientIp(c),
            c.req.header("user-agent") ?? "",
            now.toISOString().slice(0, 10),
          );
      void recordOmnigentPublishedView(engine, slug, key).catch((error) => deps.onError?.(error));
    }
    return html(200, published.html, published.audience);
  });
}
