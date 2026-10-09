import { describe, expect, it } from "vitest";
import { assertOidcConfig, checkOidcProfile, entraTenantOf, oidcLabel } from "./oidc.js";

const TENANT = "11111111-2222-3333-4444-555555555555";
const entra = {
  issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
  clientId: "c",
  clientSecret: "s",
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
