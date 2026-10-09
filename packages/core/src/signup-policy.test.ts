import { describe, expect, it } from "vitest";
import {
  admitSignup,
  emailAllowed,
  emailDeliveryConfigured,
  emailDomainOf,
  ipPrefix,
  isHostedDeployment,
  parseAllowlist,
  parseDomains,
  parseSignupMode,
  quotaEmailKey,
  type SignupPolicy,
  signupAllowlistBootUpdate,
  signupNeedsEmailDelivery,
  signupPolicyFromEnv,
  signupRequiresEmailVerification,
  unverifiedAccessAllowed,
} from "./signup-policy.js";

const policy = (over: Partial<SignupPolicy>): SignupPolicy => ({
  mode: "open",
  invites: [],
  domains: [],
  ...over,
});

describe("signup policy", () => {
  it("identifies pending signup consistently across clients without accepting malformed responses", () => {
    expect(signupRequiresEmailVerification({ token: null })).toBe(true);
    for (const response of [undefined, null, {}, { token: "session-token" }, { token: "" }]) {
      expect(signupRequiresEmailVerification(response)).toBe(false);
    }
  });

  it("matches exact addresses and domains case-insensitively, and an empty list matches nothing", () => {
    const list = parseAllowlist("You@Example.com,@company.com");
    expect(emailAllowed("you@example.com", list)).toBe(true);
    expect(emailAllowed("dev@company.com", list)).toBe(true);
    expect(emailAllowed("other@x.com", list)).toBe(false);
    expect(emailAllowed("a@x.com", [])).toBe(false);
  });

  it("normalizes domains and drops malformed entries", () => {
    expect(parseDomains(" @Corp.test, corp.test,not a domain,a@b.test,localhost")).toEqual([
      "corp.test",
    ]);
    expect(parseDomains(["Corp.test"])).toEqual(["corp.test"]);
  });

  it("derives the seed policy: explicit mode, then legacy variables", () => {
    expect(signupPolicyFromEnv({})).toEqual(policy({}));
    expect(signupPolicyFromEnv({ signupsEnabled: "false" }).mode).toBe("closed");
    expect(signupPolicyFromEnv({ signupAllowlist: " You@Example.com, @company.test " })).toEqual(
      policy({ mode: "invite", invites: ["you@example.com", "@company.test"] }),
    );
    expect(
      signupPolicyFromEnv({
        signupMode: "Domain",
        signupDomains: "@corp.test",
        signupsEnabled: "0",
      }),
    ).toEqual(policy({ mode: "domain", domains: ["corp.test"] }));
    expect(parseSignupMode("everyone")).toBeUndefined();
  });

  it("reapplies a non-empty env allowlist and leaves a blank one stored", () => {
    expect(signupAllowlistBootUpdate("old@example.test", " New@Example.test ", true)).toBe(
      "new@example.test",
    );
    expect(signupAllowlistBootUpdate("a@x.test", " a@x.test ", true)).toBeNull();
    expect(signupAllowlistBootUpdate("kept@example.test", "  ,  ", true)).toBeNull();
    expect(signupAllowlistBootUpdate("", "owner@example.test", false)).toBeNull();
  });
});

describe("admitSignup", () => {
  it("closed admits nobody", () => {
    expect(admitSignup(policy({ mode: "closed" }), "a@x.test")).toEqual({
      ok: false,
      message: "Registration is closed",
    });
  });

  it("invite admits only listed addresses and domains; an empty list admits nobody", () => {
    const invite = policy({ mode: "invite", invites: ["a@x.test", "@corp.test"] });
    expect(admitSignup(invite, "A@x.test")).toEqual({ ok: true, status: "active" });
    expect(admitSignup(invite, "b@corp.test")).toEqual({ ok: true, status: "active" });
    expect(admitSignup(invite, "b@x.test").ok).toBe(false);
    expect(admitSignup(policy({ mode: "invite" }), "a@x.test").ok).toBe(false);
  });

  it("domain admits only the listed domains, not lookalikes", () => {
    const domain = policy({ mode: "domain", domains: ["corp.test"] });
    expect(admitSignup(domain, "a@Corp.test")).toEqual({ ok: true, status: "active" });
    expect(admitSignup(domain, "a@sub.corp.test").ok).toBe(false);
    expect(admitSignup(domain, "a@corp.test.evil.test").ok).toBe(false);
  });

  it("approval queues everyone; the owner seat is claimed elsewhere, never by being first", () => {
    expect(admitSignup(policy({ mode: "approval" }), "a@x.test")).toEqual({
      ok: true,
      status: "pending",
    });
  });

  it("reads the domain after the last @", () => {
    expect(emailDomainOf('"a@corp.test"@evil.test')).toBe("evil.test");
    expect(
      admitSignup(policy({ mode: "domain", domains: ["corp.test"] }), '"a@corp.test"@evil.test').ok,
    ).toBe(false);
    expect(emailAllowed('"x@corp.test"@evil.test', ["@corp.test"])).toBe(false);
    expect(emailDomainOf("nobody")).toBe("");
  });

  it("open admits anyone as active; only the self-serve modes need email delivery", () => {
    expect(admitSignup(policy({ mode: "open" }), "a@x.test")).toEqual({
      ok: true,
      status: "active",
    });
    expect(signupNeedsEmailDelivery("closed")).toBe(false);
    expect(signupNeedsEmailDelivery("approval")).toBe(false);
    for (const mode of ["invite", "domain", "open"] as const) {
      expect(signupNeedsEmailDelivery(mode)).toBe(true);
    }
  });
});

describe("identity helpers", () => {
  it("treats production on a public origin as hosted", () => {
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

  it("allows unverified access only with no mail and approval or the personal-install flag", () => {
    const base = { hasEmailDelivery: false, devFlagAllowed: false };
    expect(unverifiedAccessAllowed({ ...base, mode: "approval" })).toBe(true);
    expect(unverifiedAccessAllowed({ ...base, mode: "open" })).toBe(false);
    expect(unverifiedAccessAllowed({ ...base, mode: "open", devFlagAllowed: true })).toBe(true);
    expect(unverifiedAccessAllowed({ ...base, mode: "approval", hasEmailDelivery: true })).toBe(
      false,
    );
  });

  it("keys rate limits on one mailbox however it is spelled, without changing identity", () => {
    expect(quotaEmailKey("Dave+one@Corp.test")).toBe("dave@corp.test");
    expect(quotaEmailKey("dave+two+x@corp.test")).toBe("dave@corp.test");
    expect(quotaEmailKey("nobody")).toBe("nobody");
  });

  it("groups clients by /24 and /64", () => {
    expect(ipPrefix("203.0.113.77")).toBe("203.0.113.0/24");
    expect(ipPrefix("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(ipPrefix(null)).toBe("unknown");
  });

  it("knows whether a process can send mail", () => {
    expect(emailDeliveryConfigured({ SMTP_URL: "smtps://x" })).toBe(true);
    expect(emailDeliveryConfigured({ NODE_ENV: "development" })).toBe(true);
    expect(emailDeliveryConfigured({ NODE_ENV: "development", EMAIL_EMULATOR: "false" })).toBe(
      false,
    );
    expect(emailDeliveryConfigured({ NODE_ENV: "production", EMAIL_EMULATOR: "true" })).toBe(false);
  });
});
