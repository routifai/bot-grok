import { describe, expect, it } from "vitest";
import {
  admitSignup,
  emailAllowed,
  parseAllowlist,
  parseDomains,
  parseSignupMode,
  type SignupPolicy,
  signupAllowlistBootUpdate,
  signupNeedsEmailDelivery,
  signupPolicyFromEnv,
  signupRequiresEmailVerification,
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

  it("approval queues everyone except the first account, which must exist to approve", () => {
    const approval = policy({ mode: "approval" });
    expect(admitSignup(approval, "a@x.test")).toEqual({ ok: true, status: "pending" });
    expect(admitSignup(approval, "a@x.test", { firstAccount: true })).toEqual({
      ok: true,
      status: "active",
    });
  });

  it("open admits anyone as active, and every mode but closed needs email delivery", () => {
    expect(admitSignup(policy({ mode: "open" }), "a@x.test")).toEqual({
      ok: true,
      status: "active",
    });
    expect(signupNeedsEmailDelivery("closed")).toBe(false);
    expect(signupNeedsEmailDelivery("open")).toBe(true);
  });
});
