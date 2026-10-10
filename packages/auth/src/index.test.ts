import { describe, expect, it, vi } from "vitest";
import {
  blockedAuthPaths,
  buildTrustedOrigins,
  passwordResetEmail,
  resolveSignupPolicy,
} from "./index.js";

describe("auth policy", () => {
  it("blocks invitation and org-creation paths in version 1", () => {
    expect(blockedAuthPaths.some((path) => path.includes("invite"))).toBe(true);
    expect(blockedAuthPaths.some((path) => path.includes("create"))).toBe(true);
  });
});

describe("buildTrustedOrigins", () => {
  it("adds the localhost twin for a 127.0.0.1 web origin", () => {
    expect(
      buildTrustedOrigins({
        webOrigin: "http://127.0.0.1:5173",
        baseURL: "http://127.0.0.1:5173",
      }),
    ).toEqual(expect.arrayContaining(["http://127.0.0.1:5173", "http://localhost:5173"]));
  });

  it("keeps extraOrigins and does not twin non-loopback hosts", () => {
    expect(
      buildTrustedOrigins({
        webOrigin: "https://app.example.test",
        baseURL: "https://api.example.test",
        extraOrigins: ["https://extra.example.test"],
      }),
    ).toEqual([
      "https://app.example.test",
      "https://api.example.test",
      "https://extra.example.test",
    ]);
  });
});

describe("passwordResetEmail", () => {
  it("keeps the reset URL in text and HTML and never echoes the user-chosen name", () => {
    const message = passwordResetEmail(
      { id: "user-1", email: "ada@example.test", name: '<Ada & "team">' },
      "https://nova.test/reset-password?token=secret&next=1",
    );

    expect(message).toMatchObject({ to: "ada@example.test", subject: "Reset your Nova password" });
    expect(message.text).toContain("https://nova.test/reset-password?token=secret&next=1");
    expect(message.html).toContain("token=secret&amp;next=1");
    expect(message.html).toContain("Nova");
    expect(`${message.text}${message.html}`).not.toContain("Ada");
  });
});

describe("resolveSignupPolicy", () => {
  it("lets a set SIGNUP_MODE decide over the stored mode, and keeps the stored mode when unset", async () => {
    const stored = {
      signupMode: "invite",
      signupAllowlist: "you@example.com",
      signupDomains: "",
      signupPolicyInitialized: true,
    };
    const prisma = { deploymentSettings: { findUnique: vi.fn().mockResolvedValue(stored) } };
    await expect(
      resolveSignupPolicy(prisma as never, { signupMode: "approval" }),
    ).resolves.toMatchObject({ mode: "approval", invites: ["you@example.com"] });
    await expect(resolveSignupPolicy(prisma as never, {})).resolves.toMatchObject({
      mode: "invite",
    });
    await expect(
      resolveSignupPolicy(prisma as never, { signupMode: "nonsense" }),
    ).resolves.toMatchObject({ mode: "invite" });
  });

  it("uses environment defaults before deployment settings exist", async () => {
    const prisma = { deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) } };
    await expect(
      resolveSignupPolicy(prisma as never, {
        signupsEnabled: "false",
        signupAllowlist: "you@example.com,@company.test",
      }),
    ).resolves.toEqual({
      mode: "closed",
      invites: ["you@example.com", "@company.test"],
      domains: [],
    });
  });

  it("keeps using the environment policy for an uninitialized row", async () => {
    const prisma = {
      deploymentSettings: {
        findUnique: vi.fn().mockResolvedValue({
          signupMode: "open",
          signupAllowlist: "",
          signupDomains: "",
          signupPolicyInitialized: false,
        }),
      },
    };
    await expect(
      resolveSignupPolicy(prisma as never, { signupAllowlist: "existing@example.com" }),
    ).resolves.toEqual({ mode: "invite", invites: ["existing@example.com"], domains: [] });
  });

  it("uses live deployment settings as the effective policy after initial seeding", async () => {
    const prisma = {
      deploymentSettings: {
        findUnique: vi.fn().mockResolvedValue({
          signupMode: "domain",
          signupAllowlist: "approved@example.com",
          signupDomains: "Corp.test,@other.test",
          signupPolicyInitialized: true,
        }),
      },
    };
    await expect(resolveSignupPolicy(prisma as never, {})).resolves.toEqual({
      mode: "domain",
      invites: ["approved@example.com"],
      domains: ["corp.test", "other.test"],
    });
  });
});
