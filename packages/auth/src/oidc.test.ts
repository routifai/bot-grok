import { describe, expect, it } from "vitest";
import { assertOidcConfig, checkOidcProfile, entraTenantOf, oidcLabel } from "./oidc.js";

const TENANT = "11111111-2222-3333-4444-555555555555";
const entra = {
  issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
  clientId: "c",
  clientSecret: "s",
  allowedDomains: ["corp.test"],
};
const google = { issuer: "https://accounts.google.com", clientId: "c", clientSecret: "s" };

describe("Microsoft Entra tenancy", () => {
  it("accepts one tenant by GUID and ignores other issuers", () => {
    expect(entraTenantOf(entra.issuer)).toBe(TENANT);
    expect(entraTenantOf(google.issuer)).toBeUndefined();
  });

  it("refuses the multi-tenant endpoints and anything that is not a GUID at startup", () => {
    for (const tenant of ["common", "organizations", "consumers", "contoso.onmicrosoft.com"]) {
      expect(() =>
        assertOidcConfig({ ...entra, issuer: `https://login.microsoftonline.com/${tenant}/v2.0` }),
      ).toThrow(/tenant/);
    }
    expect(() => assertOidcConfig({ ...entra, issuer: "http://accounts.example.test" })).toThrow(
      /https/,
    );
    expect(() => assertOidcConfig({ ...google, issuer: "http://127.0.0.1:9000" })).not.toThrow();
  });

  it("requires company domains with an Entra issuer, and refuses guests and unverified domains", () => {
    expect(() => assertOidcConfig({ ...entra, allowedDomains: [] })).toThrow(/ALLOWED_DOMAINS/);
    expect(() => assertOidcConfig(entra)).not.toThrow();
    expect(() => checkOidcProfile(entra, { email: "a@corp.test", tid: TENANT, acct: 1 })).toThrow();
    for (const edov of [false, "false", 0, "0", "maybe"]) {
      expect(() =>
        checkOidcProfile(entra, { email: "a@corp.test", tid: TENANT, xms_edov: edov }),
      ).toThrow();
    }
    expect(() => checkOidcProfile(entra, { email: "a@elsewhere.test", tid: TENANT })).toThrow();
    expect(
      checkOidcProfile(entra, { email: "a@corp.test", tid: TENANT, acct: 0, xms_edov: true }),
    ).toEqual({
      emailVerified: true,
    });
  });

  it("trusts the email only for a token issued by the configured tenant (nOAuth)", () => {
    expect(checkOidcProfile(entra, { email: "a@corp.test", tid: TENANT.toUpperCase() })).toEqual({
      emailVerified: true,
    });
    // Another tenant, or no tid at all, cannot assert someone else's address.
    expect(() => checkOidcProfile(entra, { email: "ceo@corp.test", tid: "other" })).toThrow();
    expect(() => checkOidcProfile(entra, { email: "ceo@corp.test" })).toThrow();
    // A mutable email_verified claim is not what decides it.
    expect(() =>
      checkOidcProfile(entra, { email: "ceo@corp.test", email_verified: true, tid: "other" }),
    ).toThrow();
  });
});

describe("generic and Google OIDC", () => {
  it("requires the provider to vouch for the email", () => {
    expect(() =>
      checkOidcProfile(google, { email: "a@corp.test", email_verified: false }),
    ).toThrow();
    expect(() => checkOidcProfile(google, { email: "a@corp.test" })).toThrow();
    expect(checkOidcProfile(google, { email: "a@corp.test", email_verified: true })).toEqual({
      emailVerified: true,
    });
    expect(() => checkOidcProfile(google, { email_verified: true })).toThrow();
  });

  it("limits sign-in to the allowed domains, and Google to Workspace accounts", () => {
    const pinned = { ...google, allowedDomains: ["corp.test"] };
    const ok = { email: "a@corp.test", email_verified: true, hd: "corp.test" };
    expect(checkOidcProfile(pinned, ok)).toEqual({ emailVerified: true });
    expect(() => checkOidcProfile(pinned, { ...ok, email: "a@evil.test" })).toThrow();
    expect(() => checkOidcProfile(pinned, { ...ok, hd: undefined })).toThrow();
    expect(() => checkOidcProfile(pinned, { ...ok, hd: "evil.test" })).toThrow();
    expect(() => checkOidcProfile(pinned, { ...ok, email: '"a@corp.test"@evil.test' })).toThrow();
    const okta = {
      issuer: "https://idp.corp.test",
      clientId: "c",
      clientSecret: "s",
      allowedDomains: ["corp.test"],
    };
    expect(checkOidcProfile(okta, { email: "a@corp.test", email_verified: true })).toEqual({
      emailVerified: true,
    });
  });

  it("labels the button from the issuer unless named", () => {
    expect(oidcLabel(google)).toBe("Google");
    expect(oidcLabel(entra)).toBe("Microsoft");
    expect(oidcLabel({ ...entra, name: "Contoso" })).toBe("Contoso");
    expect(oidcLabel({ ...google, issuer: "https://idp.corp.test" })).toBe("SSO");
  });
});

describe("callback path", () => {
  it("is the route better-auth serves for every provider, so the documented URI is right", async () => {
    const { OIDC_CALLBACK_PATH } = await import("./oidc.js");
    expect(OIDC_CALLBACK_PATH).toBe("/api/auth/callback/sso");
    const { betterAuth } = await import("better-auth");
    const { memoryAdapter } = await import("better-auth/adapters/memory");
    const auth = betterAuth({
      secret: "offline-auth-secret-at-least-32-characters",
      baseURL: "http://auth.example.test",
      database: memoryAdapter({ user: [], account: [], session: [], verification: [] }),
    });
    expect((auth.api as unknown as { callbackOAuth: { path: string } }).callbackOAuth.path).toBe(
      "/callback/:id",
    );
  });
});
