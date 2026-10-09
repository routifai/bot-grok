import { generateKeyPairSync, sign } from "node:crypto";
import type { TransactionalEmail } from "@nova/adapter-kit";
import { bootstrapUserSpace, personalOrganizations, quarantineUserSpaces } from "@nova/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertIdentityConfig,
  createAuth,
  isHostedDeployment,
  memoryEmailQuota,
  OWNER_SETUP_HEADER,
} from "./index.js";

// Exercise Better Auth's real routing, password hashing, verification and
// session hooks with its official offline adapter. Only persistence is faked.
vi.mock("better-auth/adapters/prisma", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return {
    prismaAdapter: (prisma: { authData: Record<string, unknown[]> }) =>
      memoryAdapter(prisma.authData),
  };
});
vi.mock("@nova/db", () => ({
  bootstrapUserSpace: vi.fn(async () => ({ spaceId: "space-1" })),
  personalOrganizations: vi.fn(async () => [{ id: "org-1", spaceIds: ["space-1"] }]),
  quarantineUserSpaces: vi.fn(async () => ({ organizationIds: ["org-1"], spaceIds: ["space-1"] })),
}));

type Mode = "closed" | "invite" | "domain" | "approval" | "open";
const SETUP_TOKEN = "operator-owner-setup-token";

function fixture({
  mode = "open",
  invites = "",
  domains = "",
  delivery = true,
  allowUnverifiedEmail = false,
  ownerSetupToken,
  nodeEnv,
  oidc,
  baseURL = "http://auth.example.test",
  webOrigin = "http://web.example.test",
  requestOrigin,
}: {
  mode?: Mode;
  invites?: string;
  domains?: string;
  delivery?: boolean;
  allowUnverifiedEmail?: boolean;
  ownerSetupToken?: string;
  nodeEnv?: string;
  oidc?: { issuer: string; clientId: string; clientSecret: string; allowedDomains?: string[] };
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
  const humans = (excluding?: string) =>
    data.user!.filter(
      (user) =>
        user.id !== excluding && !String(user.email).toLowerCase().endsWith("@messaging.invalid"),
    );
  const prisma = {
    authData: data,
    deploymentSettings: {
      findUnique: vi.fn(async () => policy),
      updateMany: vi.fn(async ({ data: patch }: { data: { ownerUserId: string } }) => {
        if (policy.ownerUserId !== null) return { count: 0 };
        policy.ownerUserId = patch.ownerUserId;
        return { count: 1 };
      }),
    },
    user: {
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { id?: { not?: string }; status?: string; email?: { equals?: string } };
        }) => {
          const found = humans(where.id?.not).find(
            (user) =>
              (where.status === undefined || user.status === where.status) &&
              (where.email?.equals === undefined ||
                String(user.email).toLowerCase() === where.email.equals.toLowerCase()),
          );
          return found ? { id: String(found.id) } : null;
        },
      ),
    },
    spaceMember: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string } }) =>
        members.has(where.userId) ? { spaceId: "space-1" } : null,
      ),
    },
  };
  Object.assign(prisma.user, {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const found = data.user!.find((user) => user.id === where.id);
      return found
        ? {
            emailVerified: found.emailVerified,
            status: found.status ?? "active",
            email: found.email,
          }
        : null;
    }),
    update: vi.fn(async ({ where, data: patch }: { where: { id: string }; data: object }) => {
      Object.assign(data.user!.find((user) => user.id === where.id)!, patch);
    }),
    updateMany: vi.fn(
      async ({
        where,
        data: patch,
      }: {
        where: { id: string; emailVerified?: boolean };
        data: object;
      }) => {
        const found = data.user!.find(
          (user) =>
            user.id === where.id &&
            (where.emailVerified === undefined || user.emailVerified === where.emailVerified),
        );
        if (found) Object.assign(found, patch);
        return { count: found ? 1 : 0 };
      },
    ),
  });
  Object.assign(prisma, {
    account: {
      deleteMany: vi.fn(
        async ({ where }: { where: { userId: string; providerId: { notIn: string[] } } }) => {
          for (let index = data.account!.length - 1; index >= 0; index -= 1) {
            const account = data.account![index]!;
            if (
              account.userId === where.userId &&
              !where.providerId.notIn.includes(String(account.providerId))
            ) {
              data.account!.splice(index, 1);
            }
          }
        },
      ),
    },
    session: {
      deleteMany: vi.fn(async ({ where }: { where: { userId: string } }) => {
        for (let index = data.session!.length - 1; index >= 0; index -= 1) {
          if (data.session![index]!.userId === where.userId) data.session!.splice(index, 1);
        }
      }),
    },
  });
  const beforeQuarantine = vi.fn(async () => undefined);
  const afterQuarantine = vi.fn(async () => undefined);
  vi.mocked(bootstrapUserSpace).mockImplementation(async (_prisma, user) => {
    members.add(user.id);
    return { spaceId: "space-1" };
  });
  const auth = createAuth(prisma as never, {
    secret: "offline-auth-secret-at-least-32-characters",
    baseURL,
    webOrigin,
    allowUnverifiedEmail,
    ownerSetupToken,
    nodeEnv,
    oidc,
    beforeQuarantine,
    afterQuarantine,
    trustedProxies: undefined,
    rateLimit: false,
    emailQuota: memoryEmailQuota(),
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
  const request = (
    path: string,
    body?: unknown,
    token?: string,
    headers: Record<string, string> = {},
  ) =>
    auth.handler(
      new Request(`${baseURL}/api/auth${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          "content-type": "application/json",
          origin: requestOrigin ?? webOrigin,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  const signup = (
    email = "approved@example.test",
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = {},
    password = "offline-password12",
  ) =>
    request(
      "/sign-up/email",
      {
        email,
        password,
        name: "Test User",
        emailVerified: true,
        id: "msg-attacker-chosen-id",
        ...extra,
      },
      undefined,
      headers,
    );
  const signin = (email = "approved@example.test", password = "offline-password12") =>
    request("/sign-in/email", { email, password });
  const lastCode = () => messages.at(-1)!.text.match(/\b\d{6}\b/)![0];
  const verify = (email = "approved@example.test", headers: Record<string, string> = {}) =>
    request("/email-otp/verify-email", { email, otp: lastCode() }, undefined, headers);
  const sendSignInCode = (email = "approved@example.test") =>
    request("/email-otp/send-verification-otp", { email, type: "sign-in" });
  const codeSignIn = (email = "approved@example.test", headers: Record<string, string> = {}) =>
    request("/sign-in/email-otp", { email, otp: lastCode() }, undefined, headers);
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
    beforeQuarantine,
    afterQuarantine,
  };
}

const sessionFor = (f: ReturnType<typeof fixture>, token: string) =>
  f.auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });

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
    // The password typed before the mailbox was proved is void; the person signs in by code.
    expect((await f.signin()).status).toBe(401);
  });

  it("rejects an unverified session wherever it is presented", async () => {
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
    expect(await sessionFor(f, "stale-token")).toBeNull();
    expect((await f.request("/update-user", { name: "Changed" }, "stale-token")).status).toBe(401);
    f.data.user![0]!.emailVerified = true;
    expect(await sessionFor(f, "stale-token")).not.toBeNull();
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

  it("caps sends and verifies per address no matter how many IPs ask", async () => {
    const f = fixture();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const response = await f.request(
        "/email-otp/send-verification-otp",
        { email: "Target@Example.test", type: "sign-in" },
        undefined,
        { "x-forwarded-for": `203.0.113.${attempt}` },
      );
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.slice(5)).toEqual([429, 429]);
    expect(f.messages).toHaveLength(5);
    // A different address is unaffected.
    expect((await f.sendSignInCode("other@example.test")).status).toBe(200);
  });

  it("refuses password signup with no email provider in a self-serve mode, unless the dev flag is set", async () => {
    const refused = fixture({ delivery: false });
    const response = await refused.signup();
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Email delivery is not configured");
    expect(refused.data.user).toHaveLength(0);

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
    const f = fixture({ delivery: false, allowUnverifiedEmail: true, nodeEnv: "production" });
    expect((await f.signup()).status).toBe(400);
    expect(f.data.user).toHaveLength(0);
  });
});

describe("pre-registering someone else's address", () => {
  it("voids a squatter's password when the real owner proves the mailbox by code", async () => {
    const f = fixture();
    const squat = await f.signup("dave@example.test", {}, {}, "squatter-password1");
    expect(squat.status).toBe(200);
    expect(f.data.account).toHaveLength(1);
    // Dave arrives, finds the address taken, and signs in with a code instead.
    await f.sendSignInCode("dave@example.test");
    expect((await f.codeSignIn("dave@example.test")).status).toBe(200);
    expect((await f.signin("dave@example.test", "squatter-password1")).status).not.toBe(200);
    expect(f.data.account).toHaveLength(0);
    expect(f.data.session).toHaveLength(1);
  });

  it("voids it when the owner verifies through the signup resend instead", async () => {
    const f = fixture();
    await f.signup("dave@example.test", {}, {}, "squatter-password1");
    expect((await f.verify("dave@example.test")).status).toBe(200);
    expect((await f.signin("dave@example.test", "squatter-password1")).status).not.toBe(200);
    expect(f.data.account).toHaveLength(0);
  });

  it("also drops sessions the squatter already held", async () => {
    const f = fixture();
    await f.signup("dave@example.test", {}, {}, "squatter-password1");
    f.data.session!.push({
      id: "squat-session",
      token: "squatter-token",
      userId: f.data.user![0]!.id,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await f.sendSignInCode("dave@example.test");
    const { token } = (await (await f.codeSignIn("dave@example.test")).json()) as { token: string };
    expect(f.data.session!.map((session) => session.token)).toEqual([token]);
  });
});

describe("assertIdentityConfig", () => {
  const withMail = { hosted: true, hasEmail: true, allowUnverifiedEmail: false };
  const withoutMail = { hosted: true, hasEmail: false, allowUnverifiedEmail: false };
  const policy = (mode: Mode) => ({ mode, invites: [], domains: [] });

  it("refuses to start a self-serve mode on a hosted deployment without an email provider", () => {
    for (const mode of ["invite", "domain", "open"] as const) {
      expect(() => assertIdentityConfig(withoutMail, policy(mode))).toThrow(/needs email delivery/);
      expect(() => assertIdentityConfig(withMail, policy(mode))).not.toThrow();
    }
    expect(() => assertIdentityConfig(withoutMail, policy("closed"))).not.toThrow();
  });

  it("lets approval run without email, but not without a way to seat an owner", () => {
    expect(() => assertIdentityConfig(withoutMail, policy("approval"))).not.toThrow();
    expect(() =>
      assertIdentityConfig({ ...withoutMail, ownerExists: false }, policy("approval")),
    ).toThrow(/OWNER_SETUP_TOKEN/);
    expect(() =>
      assertIdentityConfig(
        { ...withoutMail, ownerExists: false, ownerSetupToken: "t" },
        policy("approval"),
      ),
    ).not.toThrow();
    expect(() =>
      assertIdentityConfig({ ...withoutMail, ownerExists: true }, policy("approval")),
    ).not.toThrow();
  });

  it("refuses a hosted start that cannot tell clients apart for rate limits", () => {
    expect(() =>
      assertIdentityConfig({ ...withMail, clientIpConfigured: false }, policy("closed")),
    ).toThrow(/AUTH_TRUSTED_PROXIES or AUTH_CLIENT_IP_HEADER/);
    expect(() =>
      assertIdentityConfig({ ...withMail, clientIpConfigured: true }, policy("open")),
    ).not.toThrow();
  });

  it("requires the setup token on a hosted deployment with no owner, in every admitting mode", () => {
    for (const mode of ["invite", "domain", "approval", "open"] as const) {
      expect(() => assertIdentityConfig({ ...withMail, ownerExists: false }, policy(mode))).toThrow(
        /OWNER_SETUP_TOKEN/,
      );
      expect(() =>
        assertIdentityConfig(
          { ...withMail, ownerExists: false, ownerSetupToken: "t" },
          policy(mode),
        ),
      ).not.toThrow();
      expect(() =>
        assertIdentityConfig({ ...withMail, ownerExists: true }, policy(mode)),
      ).not.toThrow();
    }
    expect(() =>
      assertIdentityConfig({ ...withMail, ownerExists: false }, policy("closed")),
    ).not.toThrow();
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
    await f.sendSignInCode();
    expect(f.data.user).toHaveLength(0);
    expect(f.messages).toHaveLength(0);
  });

  it("invite admits listed addresses and domains only, and mails no code to anyone else", async () => {
    const f = fixture({ mode: "invite", invites: "approved@example.test,@corp.test" });
    expect((await f.signup("outsider@example.test")).status).toBe(400);
    // The answer is the same for an address that could never get an account.
    expect((await f.sendSignInCode("outsider@example.test")).status).toBe(200);
    expect(f.messages).toHaveLength(0);
    expect(f.data.user).toHaveLength(0);
    expect((await f.signup()).status).toBe(200);
    await f.verify();
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
    expect((await f.sendSignInCode("new@corp.test")).status).toBe(200);
    expect(f.messages).toHaveLength(2);
  });

  it("invite with an empty list admits nobody", async () => {
    const f = fixture({ mode: "invite" });
    expect((await f.signup()).status).toBe(400);
  });

  it("domain admits only the listed domains", async () => {
    const f = fixture({ mode: "domain", domains: "corp.test" });
    expect((await f.signup("a@other.test")).status).toBe(400);
    expect((await f.signup("a@corp.test.evil.test")).status).toBe(400);
    await f.sendSignInCode("a@other.test");
    expect(f.messages).toHaveLength(0);
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

describe("approval mode", () => {
  it("creates every account pending, even two signups before any owner exists", async () => {
    const f = fixture({ mode: "approval" });
    await f.signup("first@example.test");
    await f.signup("second@example.test", { status: "active" });
    expect(f.data.user!.map((user) => user.status)).toEqual(["pending", "pending"]);
    expect(f.policy.ownerUserId).toBeNull();
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
  });

  it("with email, the first verified account takes the seat atomically and nobody else can", async () => {
    const f = fixture({ mode: "approval" });
    await f.signup("first@example.test");
    await f.signup("second@example.test");
    // The second person verifies first and wins the seat; the first stays pending.
    f.messages.splice(0, 1);
    const second = await f.verify("second@example.test");
    expect(second.status).toBe(200);
    expect(f.policy.ownerUserId).toBe(String(f.data.user![1]!.id));
    expect(f.data.user![1]!.status).toBe("active");
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);

    f.messages.length = 0;
    await f.signin("first@example.test"); // unverified: sends a fresh code
    const first = await f.verify("first@example.test");
    const { token } = (await first.json()) as { token: string };
    expect(f.data.user![0]!.status).toBe("pending");
    expect((await sessionFor(f, token))?.user).toMatchObject({ status: "pending" });
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
  });

  it("does not reopen the seat when the owner leaves while others are active", async () => {
    const f = fixture({ mode: "approval" });
    await f.signup("owner@example.test");
    await f.verify("owner@example.test");
    f.data.user!.push({
      id: "active-1",
      email: "member@example.test",
      name: "M",
      emailVerified: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    f.policy.ownerUserId = null; // the owner deleted their account
    await f.signup("stranger@example.test");
    await f.verify("stranger@example.test");
    expect(f.policy.ownerUserId).toBeNull();
    expect(f.data.user!.find((user) => user.email === "stranger@example.test")!.status).toBe(
      "pending",
    );
  });

  it("with a setup token, only the sign-in that presents it claims the seat", async () => {
    const f = fixture({ mode: "approval", ownerSetupToken: SETUP_TOKEN });
    await f.signup("squatter@example.test");
    await f.verify("squatter@example.test");
    expect(f.policy.ownerUserId).toBeNull();

    await f.signup("owner@example.test");
    await f.verify("owner@example.test", { [OWNER_SETUP_HEADER]: "wrong-token" });
    expect(f.policy.ownerUserId).toBeNull();
    const owner = () => f.data.user!.find((user) => user.email === "owner@example.test")!;
    expect(owner().status).toBe("pending");

    await f.sendSignInCode("owner@example.test");
    const claimed = await f.codeSignIn("owner@example.test", { [OWNER_SETUP_HEADER]: SETUP_TOKEN });
    expect(claimed.status).toBe(200);
    expect(f.policy.ownerUserId).toBe(String(owner().id));
    expect(owner().status).toBe("active");
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);

    // A later holder of the token cannot take a seat that is filled.
    await f.signup("late@example.test");
    await f.verify("late@example.test", { [OWNER_SETUP_HEADER]: SETUP_TOKEN });
    expect(f.data.user!.find((user) => user.email === "late@example.test")!.status).toBe("pending");
  });

  it("with no email provider, signup works, sessions are held pending, and only the token seats an owner", async () => {
    const f = fixture({ mode: "approval", delivery: false, ownerSetupToken: SETUP_TOKEN });
    const stranger = await f.signup("stranger@example.test");
    expect(stranger.status).toBe(200);
    const { token } = (await stranger.json()) as { token: string };
    expect((await sessionFor(f, token))?.user).toMatchObject({ status: "pending" });
    expect(f.policy.ownerUserId).toBeNull();
    expect(bootstrapUserSpace).not.toHaveBeenCalled();

    const owner = await f.signup("owner@example.test", {}, { [OWNER_SETUP_HEADER]: SETUP_TOKEN });
    expect(owner.status).toBe(200);
    expect(f.policy.ownerUserId).toBe(
      String(f.data.user!.find((user) => user.email === "owner@example.test")!.id),
    );
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
  });

  it("with no email provider and no token, nobody can claim the seat", async () => {
    const f = fixture({ mode: "approval", delivery: false });
    await f.signup("a@example.test");
    await f.signup("b@example.test", {}, { [OWNER_SETUP_HEADER]: SETUP_TOKEN });
    expect(f.policy.ownerUserId).toBeNull();
    expect(f.data.user!.map((user) => user.status)).toEqual(["pending", "pending"]);
  });

  it("an approved but unverified account is held at the code step once email exists", async () => {
    const f = fixture({ mode: "approval" });
    await f.signup("later@example.test");
    f.data.user![0]!.status = "active"; // approved while there was no email provider
    expect((await f.signin("later@example.test")).status).toBe(403);
    expect(f.messages).toHaveLength(2);
    expect(f.data.session).toHaveLength(0);
  });
});

describe("suspension", () => {
  it("blocks new and existing sessions of a suspended account without saying why", async () => {
    const f = fixture();
    await f.signup();
    const { token } = (await (await f.verify()).json()) as { token: string };
    expect(await sessionFor(f, token)).not.toBeNull();
    f.data.user![0]!.status = "suspended";
    expect(await sessionFor(f, token)).toBeNull();
    await f.sendSignInCode();
    const response = await f.codeSignIn();
    expect(response.status).toBe(403);
    expect(await response.text()).not.toMatch(/suspend/i);
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

const asNetwork = (n: number) => ({ "x-forwarded-for": `198.51.${n}.7` });
const seedUnverified = (
  f: ReturnType<typeof fixture>,
  email: string,
  over: Record<string, unknown> = {},
) => {
  f.data.user!.push({
    id: `seed-${email}`,
    email,
    name: "Seed",
    emailVerified: false,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });
  f.data.account!.push({
    id: `acc-${email}`,
    userId: `seed-${email}`,
    accountId: `seed-${email}`,
    providerId: "credential",
    password: "not-a-real-hash",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return `seed-${email}`;
};

describe("proving a mailbox after unverified use", () => {
  it("quarantines the space the earlier holder used and returns the account to pending", async () => {
    const f = fixture();
    const id = seedUnverified(f, "dave@example.test");
    f.members.add(id); // it got a space while nobody could prove the address
    await f.sendSignInCode("dave@example.test");
    const response = await f.codeSignIn("dave@example.test");
    expect(response.status).toBe(200);
    const { token } = (await response.json()) as { token: string };
    // Quarantined, not deleted: Computers stopped first, then the space detached and kept.
    expect(f.beforeQuarantine).toHaveBeenCalledWith(id, ["space-1"]);
    expect(quarantineUserSpaces).toHaveBeenCalledWith(expect.anything(), id);
    expect(f.afterQuarantine).toHaveBeenCalledWith({
      userId: id,
      email: "dave@example.test",
      organizationIds: ["org-1"],
      stopFailed: false,
    });
    expect(f.data.account).toHaveLength(0);
    expect(f.data.user![0]).toMatchObject({ emailVerified: true, status: "pending" });
    expect((await sessionFor(f, token))?.user).toMatchObject({ status: "pending" });
  });

  it("leaves an account that was never used active, and only voids its password", async () => {
    const f = fixture();
    seedUnverified(f, "dave@example.test");
    await f.sendSignInCode("dave@example.test");
    await f.codeSignIn("dave@example.test");
    expect(quarantineUserSpaces).not.toHaveBeenCalled();
    expect(f.data.user![0]).toMatchObject({ emailVerified: true, status: "active" });
    expect(f.data.account).toHaveLength(0);
  });

  it("never touches the deployment owner, whose seat is bound to the operator's secret", async () => {
    const f = fixture();
    const id = seedUnverified(f, "owner@example.test");
    f.members.add(id);
    f.policy.ownerUserId = id;
    await f.sendSignInCode("owner@example.test");
    await f.codeSignIn("owner@example.test");
    expect(quarantineUserSpaces).not.toHaveBeenCalled();
    expect(f.beforeQuarantine).not.toHaveBeenCalled();
    expect(f.data.user![0]).toMatchObject({ emailVerified: true, status: "active" });
  });
});

describe("password reset is mailbox proof", () => {
  const resetByCode = async (f: ReturnType<typeof fixture>, email: string, password: string) => {
    await f.request("/email-otp/request-password-reset", { email });
    return f.request("/email-otp/reset-password", { email, otp: f.lastCode(), password });
  };

  it("voids a squatter's password, keeps the new one, and verifies the address (code reset)", async () => {
    const f = fixture();
    await f.signup("dave@example.test", {}, {}, "squatter-password1");
    const reset = await resetByCode(f, "dave@example.test", "dave-new-password1");
    expect(reset.status).toBe(200);
    expect(f.data.user![0]!.emailVerified).toBe(true);
    expect((await f.signin("dave@example.test", "squatter-password1")).status).not.toBe(200);
    expect((await f.signin("dave@example.test", "dave-new-password1")).status).toBe(200);
  });

  it("does the same through the emailed link", async () => {
    const f = fixture();
    await f.signup("dave@example.test", {}, {}, "squatter-password1");
    await f.request("/request-password-reset", {
      email: "dave@example.test",
      redirectTo: "http://web.example.test/reset-password",
    });
    const url = new URL(f.messages.at(-1)!.text.match(/http:\/\/\S+/)![0]);
    const token = url.pathname.split("/").pop()!;
    const reset = await f.request("/reset-password", { token, newPassword: "dave-new-password1" });
    expect(reset.status).toBe(200);
    expect(f.data.user![0]!.emailVerified).toBe(true);
    expect((await f.signin("dave@example.test", "squatter-password1")).status).not.toBe(200);
    expect((await f.signin("dave@example.test", "dave-new-password1")).status).toBe(200);
  });

  it("caps reset requests per address", async () => {
    const f = fixture();
    await f.signup("dave@example.test");
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      statuses.push(
        (await f.request("/email-otp/request-password-reset", { email: "dave@example.test" }))
          .status,
      );
    }
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
  });
});

describe("hosted owner seat", () => {
  it("does not seat the first verified stranger in approval mode without the setup token", async () => {
    const f = fixture({ mode: "approval", nodeEnv: "production" });
    await f.signup("stranger@example.test");
    await f.verify("stranger@example.test");
    expect(f.policy.ownerUserId).toBeNull();
    expect(f.data.user![0]!.status).toBe("pending");
    f.messages.length = 0;
    await f.sendSignInCode("stranger@example.test");
    await f.codeSignIn("stranger@example.test", { [OWNER_SETUP_HEADER]: "wrong" });
    expect(f.policy.ownerUserId).toBeNull();
  });

  it("does not make the first invited person owner without the token, in any mode", async () => {
    const f = fixture({
      mode: "invite",
      invites: "@example.test",
      nodeEnv: "production",
      ownerSetupToken: SETUP_TOKEN,
    });
    await f.signup("first@example.test");
    await f.verify("first@example.test");
    expect(bootstrapUserSpace).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { claimDeploymentOwner: false },
    );
    await f.signup("second@example.test");
    f.messages.splice(0, f.messages.length - 1);
    await f.verify("second@example.test", { [OWNER_SETUP_HEADER]: SETUP_TOKEN });
    expect(bootstrapUserSpace).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { claimDeploymentOwner: true },
    );
  });

  it("keeps the first-verified-claims rule on a personal install", async () => {
    const f = fixture({ mode: "approval" });
    await f.signup("owner@example.test");
    await f.verify("owner@example.test");
    expect(f.policy.ownerUserId).not.toBeNull();
  });
});

describe("per-address limits", () => {
  it("caps sends per address and network, then overall, so other networks still work", async () => {
    const f = fixture();
    const send = (network: number, email = "target@example.test") =>
      f.request(
        "/email-otp/send-verification-otp",
        { email, type: "sign-in" },
        undefined,
        asNetwork(network),
      );
    const fromA: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) fromA.push((await send(1)).status);
    expect(fromA).toEqual([200, 200, 200, 200, 200, 429, 429]);
    // A different network is not locked out by the first one's traffic.
    expect((await send(2)).status).toBe(200);
    // ...until the looser per-address cap across all networks is reached.
    let blocked = 0;
    for (let network = 3; network < 40; network += 1) {
      if ((await send(network)).status === 429) blocked += 1;
    }
    expect(blocked).toBeGreaterThan(0);
    expect(f.messages.length).toBeLessThanOrEqual(21);
  });

  it("treats +tags as the same mailbox for limits, without changing who the account is", async () => {
    const f = fixture();
    const statuses: number[] = [];
    for (const tag of ["a", "b", "c", "d", "e", "f"]) {
      statuses.push(
        (
          await f.request("/email-otp/send-verification-otp", {
            email: `dave+${tag}@example.test`,
            type: "sign-in",
          })
        ).status,
      );
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });

  it("counts only failures for code attempts, per network, in a short window", async () => {
    const f = fixture();
    await f.sendSignInCode("target@example.test");
    const wrong = (network: number) =>
      f.request(
        "/sign-in/email-otp",
        { email: "target@example.test", otp: "000000" },
        undefined,
        asNetwork(network),
      );
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) statuses.push((await wrong(1)).status);
    expect(statuses.slice(0, 8).every((status) => status !== 429)).toBe(true);
    expect(statuses.slice(8)).toEqual([429, 429]);
    // The person themselves, from another network, is not locked out of the right code.
    const right = await f.request(
      "/sign-in/email-otp",
      { email: "target@example.test", otp: f.lastCode() },
      undefined,
      asNetwork(2),
    );
    expect([200, 400, 401, 403]).toContain(right.status);
    expect(right.status).not.toBe(429);
  });

  it("does not count successful sign-ins against anyone", async () => {
    const f = fixture();
    await f.signup("dave@example.test");
    await f.verify("dave@example.test");
    f.data.user![0]!.emailVerified = true;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await f.sendSignInCode("dave@example.test").catch(() => undefined);
    }
    expect(f.data.user).toHaveLength(1);
  });
});

describe("enumeration and background surfaces", () => {
  it("answers a repeat signup like a new one when no mail can prove the address", async () => {
    const f = fixture({ mode: "approval", delivery: false });
    await f.signup("dave@example.test");
    const again = await f.signup("dave@example.test");
    expect(again.status).toBe(200);
    expect(await again.text()).not.toMatch(/exist/i);
    expect(f.data.user).toHaveLength(1);
  });

  it("keeps pending accounts away from organization endpoints", async () => {
    const f = fixture({ mode: "approval", delivery: false });
    const signup = await f.signup("dave@example.test");
    const { token } = (await signup.json()) as { token: string };
    expect((await sessionFor(f, token))?.user).toMatchObject({ status: "pending" });
    const listed = await f.request("/organization/list", undefined, token);
    expect(listed.status).toBe(401);
  });
});

describe("quarantine details", () => {
  it("still quarantines when stopping a Computer fails, and says so", async () => {
    const f = fixture();
    const id = seedUnverified(f, "dave@example.test");
    f.members.add(id);
    f.beforeQuarantine.mockRejectedValueOnce(new Error("provider down"));
    await f.sendSignInCode("dave@example.test");
    expect((await f.codeSignIn("dave@example.test")).status).toBe(200);
    expect(quarantineUserSpaces).toHaveBeenCalled();
    expect(f.afterQuarantine).toHaveBeenCalledWith(expect.objectContaining({ stopFailed: true }));
    expect(f.data.user![0]!.status).toBe("pending");
  });

  it("drops a session that was created while the void was running", async () => {
    const f = fixture();
    const id = seedUnverified(f, "dave@example.test");
    f.members.add(id);
    vi.mocked(quarantineUserSpaces).mockImplementationOnce(async () => {
      f.data.session!.push({
        id: "raced",
        token: "raced-token",
        userId: id,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return { organizationIds: ["org-1"], spaceIds: ["space-1"] };
    });
    await f.sendSignInCode("dave@example.test");
    const { token } = (await (await f.codeSignIn("dave@example.test")).json()) as { token: string };
    expect(f.data.session!.map((session) => session.token)).toEqual([token]);
    expect(personalOrganizations).toHaveBeenCalled();
  });
});

describe("SSO linking end to end (stubbed identity provider)", () => {
  const ISSUER = "https://idp.example.test";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

  function stubIdp(email: string, claims: Record<string, unknown> = {}) {
    let nonce = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
        if (url.pathname.endsWith("/.well-known/openid-configuration")) {
          return json({
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/authorize`,
            token_endpoint: `${ISSUER}/token`,
            jwks_uri: `${ISSUER}/jwks`,
            id_token_signing_alg_values_supported: ["RS256"],
          });
        }
        if (url.pathname === "/jwks") return json({ keys: [jwk] });
        if (url.pathname === "/token") {
          const now = Math.floor(Date.now() / 1000);
          const head = b64({ alg: "RS256", kid: "k1", typ: "JWT" });
          const body = b64({
            iss: ISSUER,
            aud: "client-id",
            sub: `idp-${email}`,
            email,
            email_verified: true,
            name: "Person",
            nonce,
            iat: now,
            exp: now + 300,
            ...claims,
          });
          const signature = sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString(
            "base64url",
          );
          return json({
            access_token: "at",
            token_type: "Bearer",
            expires_in: 300,
            id_token: `${head}.${body}.${signature}`,
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    return (value: string) => {
      nonce = value;
    };
  }

  async function signInWithSso(
    f: ReturnType<typeof fixture>,
    setNonce: (nonce: string) => void,
    cookie = "",
  ) {
    await f.auth.$context;
    const start = await f.request(
      "/sign-in/social",
      { provider: "sso", callbackURL: "http://web.example.test/app" },
      undefined,
      cookie ? { cookie } : {},
    );
    const { url } = (await start.json()) as { url: string };
    const authorize = new URL(url);
    setNonce(authorize.searchParams.get("nonce") ?? "");
    const stateCookies = start.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .concat(cookie ? [cookie] : [])
      .join("; ");
    return f.request(
      `/callback/sso?code=c1&state=${authorize.searchParams.get("state")}`,
      undefined,
      undefined,
      { cookie: stateCookies },
    );
  }

  const oidc = {
    issuer: ISSUER,
    clientId: "client-id",
    clientSecret: "s",
    allowedDomains: ["example.test"],
  };

  it("links to an unverified, used row: keeps sso, drops the password, quarantines the space", async () => {
    const f = fixture({ oidc });
    const id = seedUnverified(f, "erin@example.test");
    f.members.add(id);
    f.data.account!.push({
      id: "acc-attached",
      userId: id,
      accountId: "x",
      providerId: "github",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const setNonce = stubIdp("erin@example.test");
    const response = await signInWithSso(f, setNonce);
    vi.unstubAllGlobals();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).not.toMatch(/error/);
    expect(f.data.account!.map((account) => account.providerId)).toEqual(["sso"]);
    expect(f.data.user![0]).toMatchObject({ emailVerified: true, status: "pending" });
    expect(quarantineUserSpaces).toHaveBeenCalledWith(expect.anything(), id);
    expect(f.beforeQuarantine).toHaveBeenCalledWith(id, ["space-1"]);
    expect(f.data.session).toHaveLength(1);
  });

  it("does not link at all when SSO is not pinned to company domains", async () => {
    const f = fixture({ oidc: { ...oidc, allowedDomains: [] } });
    seedUnverified(f, "erin@example.test");
    const setNonce = stubIdp("erin@example.test");
    const response = await signInWithSso(f, setNonce);
    vi.unstubAllGlobals();
    expect(f.data.account!.map((account) => account.providerId)).toEqual(["credential"]);
    expect(response.headers.get("location") ?? "").toMatch(/error|account_not_linked/);
  });

  it("never links the deployment owner implicitly", async () => {
    const f = fixture({ oidc });
    const id = seedUnverified(f, "owner@example.test", { emailVerified: true });
    f.policy.ownerUserId = id;
    const setNonce = stubIdp("owner@example.test");
    await signInWithSso(f, setNonce);
    vi.unstubAllGlobals();
    expect(f.data.account!.map((account) => account.providerId)).toEqual(["credential"]);
  });
});
