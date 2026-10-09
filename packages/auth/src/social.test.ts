import { describe, expect, it } from "vitest";
import { assertGoogleHostedDomain, socialProviderIds, socialProviders } from "./social.js";

describe("social providers", () => {
  it("is empty until configured, and lists what is on", () => {
    expect(socialProviders(undefined)).toEqual({});
    expect(socialProviderIds(undefined)).toEqual([]);
    expect(
      socialProviderIds({
        google: { clientId: "g", clientSecret: "s" },
        microsoft: { clientId: "m", clientSecret: "s", tenantId: "tenant-1" },
      }),
    ).toEqual(["google", "microsoft"]);
  });

  it("pins Google to the workspace domain and Microsoft to one tenant", () => {
    const providers = socialProviders({
      google: { clientId: "g", clientSecret: "s", hostedDomain: "corp.test" },
      microsoft: { clientId: "m", clientSecret: "s", tenantId: "tenant-1" },
    }) as {
      google: { hd: string; mapProfileToUser: (profile: object) => object };
      microsoft: { tenantId: string; mapProfileToUser: (profile: object) => object };
    };
    expect(providers.google.hd).toBe("corp.test");
    expect(providers.microsoft.tenantId).toBe("tenant-1");
    expect(providers.microsoft.mapProfileToUser({ email: "a@corp.test" })).toEqual({
      emailVerified: true,
    });
    expect(() =>
      providers.google.mapProfileToUser({ email: "a@evil.test", email_verified: true }),
    ).toThrow();
  });
});

describe("assertGoogleHostedDomain", () => {
  it("requires a Google-verified address in the configured domain", () => {
    expect(() =>
      assertGoogleHostedDomain({ email: "A@Corp.test", email_verified: true }, "corp.test"),
    ).not.toThrow();
    expect(() =>
      assertGoogleHostedDomain({ email: "a@corp.test", email_verified: false }, "corp.test"),
    ).toThrow();
    expect(() =>
      assertGoogleHostedDomain(
        { email: "a@corp.test.evil.test", email_verified: true },
        "corp.test",
      ),
    ).toThrow();
  });

  it("does nothing when no domain is configured", () => {
    expect(() => assertGoogleHostedDomain({ email: "a@any.test" }, undefined)).not.toThrow();
  });
});
