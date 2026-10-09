import type { TransactionalEmail } from "@nova/adapter-kit";
import { bootstrapUserSpace } from "@nova/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertIdentityConfig, createAuth, isHostedDeployment } from "./index.js";

// Exercise Better Auth's real routing, password hashing, verification and
// session hooks with its official offline adapter. Only persistence is faked.
vi.mock("better-auth/adapters/prisma", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return {
    prismaAdapter: (prisma: { authData: Record<string, unknown[]> }) =>
      memoryAdapter(prisma.authData),
  };
});
vi.mock("@nova/db", () => ({ bootstrapUserSpace: vi.fn(async () => ({ spaceId: "space-1" })) }));

type Mode = "closed" | "invite" | "domain" | "approval" | "open";

function fixture({
  mode = "open",
  invites = "",
  domains = "",
  delivery = true,
  allowUnverifiedEmail = false,
  baseURL = "http://auth.example.test",
  webOrigin = "http://web.example.test",
  requestOrigin,
}: {
  mode?: Mode;
  invites?: string;
  domains?: string;
  delivery?: boolean;
  allowUnverifiedEmail?: boolean;
  baseURL?: string;
  webOrigin?: string;
  requestOrigin?: string;
} = {}) {
  const data: Record<string, Record<string, unknown>[]> = {
    user: [],
    account: [],
    session: [],
    verification: [],
  };
  const policy = {
    signupMode: mode,
    signupAllowlist: invites,
    signupDomains: domains,
    signupPolicyInitialized: true,
    ownerUserId: null as string | null,
  };
  const messages: TransactionalEmail[] = [];
  const members = new Set<string>();
  const prisma = {
    authData: data,
    deploymentSettings: { findUnique: vi.fn(async () => policy) },
    spaceMember: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string } }) =>
        members.has(where.userId) ? { spaceId: "space-1" } : null,
      ),
    },
  };
  vi.mocked(bootstrapUserSpace).mockImplementation(async (_prisma, user) => {
    members.add(user.id);
    return { spaceId: "space-1" };
  });
  const auth = createAuth(prisma as never, {
    secret: "offline-auth-secret-at-least-32-characters",
    baseURL,
    webOrigin,
    allowUnverifiedEmail,
    email: delivery
      ? {
          describe: () => ({
            id: "offline-email",
            contractVersion: "1",
            adapterVersion: "1",
            capabilities: { transactional: true },
          }),
          send: async (message) => {
            messages.push(message);
          },
        }
      : undefined,
  });
  const request = (path: string, body?: unknown, token?: string) =>
    auth.handler(
      new Request(`${baseURL}/api/auth${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          "content-type": "application/json",
          origin: requestOrigin ?? webOrigin,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  const signup = (email = "approved@example.test", extra: Record<string, unknown> = {}) =>
    request("/sign-up/email", {
      email,
      password: "offline-password12",
      name: "Test User",
      emailVerified: true,
      id: "msg-attacker-chosen-id",
      ...extra,
    });
  const signin = (email = "approved@example.test") =>
    request("/sign-in/email", { email, password: "offline-password12" });
  const lastCode = () => messages.at(-1)!.text.match(/\b\d{6}\b/)![0];
  const verify = (email = "approved@example.test") =>
    request("/email-otp/verify-email", { email, otp: lastCode() });
  const sendSignInCode = (email = "approved@example.test") =>
    request("/email-otp/send-verification-otp", { email, type: "sign-in" });
  const codeSignIn = (email = "approved@example.test") =>
    request("/sign-in/email-otp", { email, otp: lastCode() });
  return {
    auth,
    request,
    signup,
    signin,
    verify,
    sendSignInCode,
    codeSignIn,
    lastCode,
    data,
    policy,
    messages,
    members,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("loopback trusted origins", () => {
  it("accepts Origin localhost when webOrigin is 127.0.0.1", async () => {
    const f = fixture({
      baseURL: "http://127.0.0.1:5173",
      webOrigin: "http://127.0.0.1:5173",
      requestOrigin: "http://localhost:5173",
    });
    expect((await f.signup()).status).toBe(200);
  });

  it("accepts Origin 127.0.0.1 when webOrigin is localhost", async () => {
    const f = fixture({
      baseURL: "http://localhost:5173",
      webOrigin: "http://localhost:5173",
      requestOrigin: "http://127.0.0.1:5173",
    });
    expect((await f.signup()).status).toBe(200);
  });
});

describe("verified email", () => {
  it("gives no session, space or owner claim until a code proves the mailbox", async () => {
    const f = fixture();
    const response = await f.signup();
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toMatchObject({ token: null, user: { emailVerified: false } });
    expect(f.data.user![0]!.id).not.toBe("msg-attacker-chosen-id");
    expect(f.data.session).toHaveLength(0);
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]!.subject).toMatch(/^\d{6} is your Nova code$/);
    expect(f.messages[0]!.html).toContain("Nova");

    expect((await f.signin()).status).toBe(403);
    expect(f.messages).toHaveLength(2);
    expect(
      (
        await f.request("/email-otp/verify-email", {
          email: "approved@example.test",
          otp: "000000",
        })
      ).status,
    ).not.toBe(200);
    expect(f.data.user![0]!.emailVerified).toBe(false);

    const verified = await f.verify();
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({ token: expect.any(String) });
    expect(f.data.user![0]!.emailVerified).toBe(true);
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
    expect((await f.signin()).status).toBe(200);
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
  });

  it("rejects an unverified session wherever it is presented, even with no signup restriction", async () => {
    const f = fixture();
    f.data.user!.push({
      id: "user-1",
      email: "ghost@example.test",
      name: "Ghost",
      emailVerified: false,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    f.data.session!.push({
      id: "session-1",
      token: "stale-token",
      userId: "user-1",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(
      await f.auth.api.getSession({
        headers: new Headers({ authorization: "Bearer stale-token" }),
      }),
    ).toBeNull();
    expect((await f.request("/update-user", { name: "Changed" }, "stale-token")).status).toBe(401);
    f.data.user![0]!.emailVerified = true;
    expect(
      await f.auth.api.getSession({
        headers: new Headers({ authorization: "Bearer stale-token" }),
      }),
    ).not.toBeNull();
  });

  it("signs in with an emailed code and creates a verified account", async () => {
    const f = fixture();
    expect((await f.sendSignInCode()).status).toBe(200);
    expect(f.messages).toHaveLength(1);
    expect(
      (await f.request("/sign-in/email-otp", { email: "approved@example.test", otp: "000000" }))
        .status,
    ).not.toBe(200);
    expect(f.data.user).toHaveLength(0);
    const response = await f.codeSignIn();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      token: expect.any(String),
      user: { emailVerified: true },
    });
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
  });

  it("limits a code to a few attempts", async () => {
    const f = fixture();
    await f.sendSignInCode();
    const real = f.lastCode();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await f.request("/sign-in/email-otp", { email: "approved@example.test", otp: "000000" });
    }
    expect(
      (await f.request("/sign-in/email-otp", { email: "approved@example.test", otp: real })).status,
    ).not.toBe(200);
    expect(f.data.user).toHaveLength(0);
  });

  it("refuses password signup with no email provider, unless the dev flag is set outside production", async () => {
    const closedOff = fixture({ delivery: false });
    const refused = await closedOff.signup();
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("Email delivery is not configured");
    expect(closedOff.data.user).toHaveLength(0);

    const dev = fixture({ delivery: false, allowUnverifiedEmail: true });
    const accepted = await dev.signup();
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      token: expect.any(String),
      user: { emailVerified: false },
    });
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
  });

  it("never honors the dev flag on a hosted deployment", async () => {
    const f = fixture({ delivery: false, allowUnverifiedEmail: true });
    const prod = createAuth({ deploymentSettings: { findUnique: async () => f.policy } } as never, {
      secret: "offline-auth-secret-at-least-32-characters",
      baseURL: "http://auth.example.test",
      webOrigin: "http://web.example.test",
      allowUnverifiedEmail: true,
      nodeEnv: "production",
    });
    const response = await prod.handler(
      new Request("http://auth.example.test/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://web.example.test" },
        body: JSON.stringify({
          email: "a@example.test",
          password: "offline-password12",
          name: "A",
        }),
      }),
    );
    expect(response.status).toBe(400);
  });
});

describe("assertIdentityConfig", () => {
  const withMail = { hosted: true, hasEmail: true, allowUnverifiedEmail: false };
  const withoutMail = { hosted: true, hasEmail: false, allowUnverifiedEmail: false };
  const policy = (mode: Mode) => ({ mode, invites: [], domains: [] });

  it("refuses to start an admitting mode in production without an email provider", () => {
    for (const mode of ["invite", "domain", "approval", "open"] as const) {
      expect(() => assertIdentityConfig(withoutMail, policy(mode))).toThrow(/needs email delivery/);
      expect(() => assertIdentityConfig(withMail, policy(mode))).not.toThrow();
    }
    expect(() => assertIdentityConfig(withoutMail, policy("closed"))).not.toThrow();
  });

  it("treats production on a public origin as hosted, and loopback or non-production as local", () => {
    expect(
      isHostedDeployment({ nodeEnv: "production", webOrigin: "https://app.example.test" }),
    ).toBe(true);
    expect(isHostedDeployment({ nodeEnv: "production", webOrigin: "http://127.0.0.1:5173" })).toBe(
      false,
    );
    expect(
      isHostedDeployment({ nodeEnv: "development", webOrigin: "https://app.example.test" }),
    ).toBe(false);
  });

  it("refuses the unverified-email flag when hosted and ignores it elsewhere", () => {
    expect(() =>
      assertIdentityConfig({ ...withMail, allowUnverifiedEmail: true }, policy("closed")),
    ).toThrow(/local development/);
    expect(() =>
      assertIdentityConfig(
        { hosted: false, hasEmail: false, allowUnverifiedEmail: true },
        policy("open"),
      ),
    ).not.toThrow();
  });
});

describe("signup modes", () => {
  it("closed refuses every route in", async () => {
    const f = fixture({ mode: "closed" });
    const response = await f.signup();
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Registration is closed");
    expect((await f.sendSignInCode()).status).toBe(400);
    expect(f.data.user).toHaveLength(0);
    expect(f.messages).toHaveLength(0);
  });

  it("invite admits listed addresses and domains only, and mails no code to anyone else", async () => {
    const f = fixture({ mode: "invite", invites: "approved@example.test,@corp.test" });
    expect((await f.signup("outsider@example.test")).status).toBe(400);
    expect((await f.sendSignInCode("outsider@example.test")).status).toBe(400);
    expect(f.messages).toHaveLength(0);
    expect(f.data.user).toHaveLength(0);
    expect((await f.signup()).status).toBe(200);
    await f.verify();
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
    expect((await f.sendSignInCode("new@corp.test")).status).toBe(200);
  });

  it("invite with an empty list admits nobody", async () => {
    const f = fixture({ mode: "invite" });
    expect((await f.signup()).status).toBe(400);
  });

  it("domain admits only the listed domains", async () => {
    const f = fixture({ mode: "domain", domains: "corp.test" });
    expect((await f.signup("a@other.test")).status).toBe(400);
    expect((await f.signup("a@corp.test.evil.test")).status).toBe(400);
    expect((await f.sendSignInCode("a@other.test")).status).toBe(400);
    expect((await f.signup("a@corp.test")).status).toBe(200);
    // An email-code account is checked at creation too, not only at the signup route.
    await f.sendSignInCode("b@corp.test");
    expect((await f.codeSignIn("b@corp.test")).status).toBe(200);
    f.policy.signupDomains = "elsewhere.test";
    await f.sendSignInCode("c@elsewhere.test");
    f.policy.signupDomains = "corp.test";
    expect((await f.codeSignIn("c@elsewhere.test")).status).not.toBe(200);
    expect(f.data.user!.map((user) => user.email)).toEqual(["a@corp.test", "b@corp.test"]);
  });

  it("approval: the first account is active, later ones wait with no space until approved", async () => {
    const f = fixture({ mode: "approval" });
    await f.signup("owner@example.test");
    await f.verify("owner@example.test");
    expect(f.data.user![0]!.status).toBe("active");
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
    f.policy.ownerUserId = String(f.data.user![0]!.id);

    // A client cannot pick its own status.
    const response = await f.signup("waiting@example.test", { status: "active" });
    expect(response.status).toBe(200);
    expect(f.data.user![1]!.status).toBe("pending");
    const verified = await f.verify("waiting@example.test");
    const { token } = (await verified.json()) as { token: string };
    expect(token).toEqual(expect.any(String));

    // Signed in, but nothing is provisioned.
    const session = await f.auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${token}` }),
    });
    expect(session?.user).toMatchObject({ email: "waiting@example.test", status: "pending" });
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
    expect((await f.signin("waiting@example.test")).status).toBe(200);
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);

    // Approval flips the status; the next sign-in provisions (approveSignup also does at once).
    f.data.user![1]!.status = "active";
    expect((await f.signin("waiting@example.test")).status).toBe(200);
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(2);
  });

  it("open admits anyone once their mailbox is proved", async () => {
    const f = fixture({ mode: "open" });
    expect((await f.signup("anyone@anywhere.test")).status).toBe(200);
    await f.verify("anyone@anywhere.test");
    expect(f.data.user![0]!.status).toBe("active");
  });

  it("rechecks policy before provisioning a verified but unprovisioned account", async () => {
    const f = fixture({ mode: "domain", domains: "example.test" });
    await f.signup();
    f.data.user![0]!.emailVerified = true;
    f.policy.signupMode = "closed";
    expect((await f.signin()).status).toBe(403);
    f.policy.signupMode = "domain";
    f.policy.signupDomains = "elsewhere.test";
    expect((await f.signin()).status).toBe(403);
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
  });
});

describe("suspension", () => {
  it("blocks new and existing sessions of a suspended account", async () => {
    const f = fixture();
    await f.signup();
    const { token } = (await (await f.verify()).json()) as { token: string };
    const headers = () => new Headers({ authorization: `Bearer ${token}` });
    expect(await f.auth.api.getSession({ headers: headers() })).not.toBeNull();
    f.data.user![0]!.status = "suspended";
    expect(await f.auth.api.getSession({ headers: headers() })).toBeNull();
    const response = await f.signin();
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Account suspended");
  });
});

describe("internal messaging identities", () => {
  it("reserves internal messaging emails across registration, recovery and email changes", async () => {
    const f = fixture();
    for (const email of [
      "msg-sendblue15550001111@messaging.invalid",
      "MSG-Test@MESSAGING.INVALID",
    ]) {
      expect((await f.signup(email)).status).toBe(400);
      expect((await f.signin(email)).status).toBe(400);
      expect((await f.sendSignInCode(email)).status).toBe(400);
      expect((await f.request("/request-password-reset", { email })).status).toBe(400);
    }
    expect(f.data.user).toHaveLength(0);
    await f.signup();
    const { token } = (await (await f.verify()).json()) as { token: string };
    expect(
      (await f.request("/change-email", { newEmail: "msg-taken@messaging.invalid" }, token)).status,
    ).toBe(400);
    // An account preclaimed before this upgrade must not keep its session.
    f.data.user![0]!.email = "msg-taken@messaging.invalid";
    expect(await (await f.request("/get-session", undefined, token)).json()).toBeNull();
    expect((await f.request("/update-user", { name: "Changed" }, token)).status).toBe(401);
  });
});
