import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const base = {
  DATABASE_URL: "postgres://nova:nova@127.0.0.1:5433/nova",
  NODE_ENV: "test",
};

describe("loadEnv", () => {
  it("defaults the product path to Pi, Docker, and Graphile Worker", () => {
    const env = loadEnv(base);
    expect(env.agentRuntime).toBe("pi");
    expect(env.sandboxProvider).toBe("docker");
    expect(env.wakeupDriver).toBe("graphile");
    expect(env.apiHost).toBe("127.0.0.1");
    expect(env.nodeEnv).toBe("test");
  });

  it("keeps explicit emulator settings for pnpm test", () => {
    const env = loadEnv({
      ...base,
      AGENT_RUNTIME: "scripted",
      SANDBOX_PROVIDER: "fake",
      WAKEUP_DRIVER: "memory",
    });
    expect(env.agentRuntime).toBe("scripted");
    expect(env.sandboxProvider).toBe("fake");
    expect(env.wakeupDriver).toBe("memory");
  });

  it("keeps the unverified-email escape hatch off unless explicitly set", () => {
    expect(loadEnv(base).allowUnverifiedEmail).toBe(false);
    expect(loadEnv({ ...base, AUTH_ALLOW_UNVERIFIED_EMAIL: "true" }).allowUnverifiedEmail).toBe(
      true,
    );
  });

  it("reads signup mode and the HTTP email provider", () => {
    const env = loadEnv({
      ...base,
      SIGNUP_MODE: "approval",
      SIGNUP_DOMAINS: "corp.test",
      EMAIL_API_URL: "https://mail.example.test/emails",
      EMAIL_API_KEY: "key",
    });
    expect([env.signupMode, env.signupDomains]).toEqual(["approval", "corp.test"]);
    expect([env.emailApiUrl, env.emailApiKey]).toEqual(["https://mail.example.test/emails", "key"]);
  });

  it("enables one generic OIDC connection only when fully configured", () => {
    expect(loadEnv(base).oidc).toBeUndefined();
    expect(
      loadEnv({
        ...base,
        AUTH_OIDC_ISSUER: "https://accounts.google.com",
        AUTH_OIDC_CLIENT_ID: "g",
        AUTH_OIDC_CLIENT_SECRET: "s",
        AUTH_OIDC_ALLOWED_DOMAINS: "@Corp.test, corp.test",
      }).oidc,
    ).toEqual({
      issuer: "https://accounts.google.com",
      clientId: "g",
      clientSecret: "s",
      name: undefined,
      allowedDomains: ["corp.test"],
    });
    expect(() => loadEnv({ ...base, AUTH_OIDC_ISSUER: "https://accounts.google.com" })).toThrow(
      /go together/,
    );
  });

  it("refuses a multi-tenant Microsoft issuer at startup", () => {
    for (const tenant of ["common", "organizations", "consumers"]) {
      expect(() =>
        loadEnv({
          ...base,
          AUTH_OIDC_ISSUER: `https://login.microsoftonline.com/${tenant}/v2.0`,
          AUTH_OIDC_CLIENT_ID: "m",
          AUTH_OIDC_CLIENT_SECRET: "s",
        }),
      ).toThrow(/tenant/);
    }
  });

  it("reads the owner setup token, proxy trust and the dev email emulator default", () => {
    const env = loadEnv({
      ...base,
      OWNER_SETUP_TOKEN: " tok ",
      AUTH_TRUSTED_PROXIES: "10.0.0.0/24, 192.0.2.1",
      AUTH_CLIENT_IP_HEADER: "x-real-ip",
    });
    expect([env.ownerSetupToken, env.trustedProxies, env.clientIpHeader]).toEqual([
      "tok",
      ["10.0.0.0/24", "192.0.2.1"],
      "x-real-ip",
    ]);
    expect(loadEnv({ ...base, NODE_ENV: "development" }).emailEmulator).toBe(true);
    expect(
      loadEnv({ ...base, NODE_ENV: "development", EMAIL_EMULATOR: "false" }).emailEmulator,
    ).toBe(false);
    expect(loadEnv(base).emailEmulator).toBe(false);
  });

  it("loads an optional integrations catalog mirror", () => {
    expect(loadEnv(base).integrationsCatalogUrl).toBeUndefined();
    expect(
      loadEnv({ ...base, INTEGRATIONS_CATALOG_URL: " https://catalog.example.test/feed " })
        .integrationsCatalogUrl,
    ).toBe("https://catalog.example.test/feed");
  });

  it("falls back to none when a remote provider key is missing", () => {
    expect(
      loadEnv({
        ...base,
        SANDBOX_PROVIDER: "e2b",
      }).sandboxProvider,
    ).toBe("none");
    expect(
      loadEnv({
        ...base,
        SANDBOX_PROVIDER: "createos",
      }).sandboxProvider,
    ).toBe("none");
    expect(
      loadEnv({
        ...base,
        SANDBOX_PROVIDER: "none",
      }).sandboxProvider,
    ).toBe("none");
    expect(
      loadEnv({
        ...base,
        SANDBOX_PROVIDER: "",
      }).sandboxProvider,
    ).toBe("none");
  });

  it("loads provider-specific Daytona configuration", () => {
    const env = loadEnv({
      ...base,
      SANDBOX_PROVIDER: "daytona",
      DAYTONA_API_KEY: "test-daytona-key",
      DAYTONA_API_URL: "https://daytona.test/api",
      DAYTONA_TARGET: "test-target",
    });
    expect(env).toMatchObject({
      sandboxProvider: "daytona",
      daytonaApiKey: "test-daytona-key",
      daytonaApiUrl: "https://daytona.test/api",
      daytonaTarget: "test-target",
    });
  });

  it("loads provider-specific Box configuration", () => {
    const env = loadEnv({
      ...base,
      SANDBOX_PROVIDER: "box",
      BOX_API_KEY: "test-box-key",
      BOX_API_URL: "https://box.test/api/v1",
    });
    expect(env).toMatchObject({
      sandboxProvider: "box",
      boxApiKey: "test-box-key",
      boxApiUrl: "https://box.test/api/v1",
    });
  });

  it("throws when production omits secrets", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: base.DATABASE_URL,
        NODE_ENV: "production",
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("throws when production uses placeholder secrets", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: base.DATABASE_URL,
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "dev-secret-change-me-please-32chars",
        ENCRYPTION_KEY: "real-encryption-key-value",
        SANDBOX_SUPERVISOR_TOKEN: "real-supervisor-token-with-enough-length",
        SCREEN_PROXY_SECRET: "real-screen-proxy-secret-with-enough-length",
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("loads real secrets in production", () => {
    const env = loadEnv({
      DATABASE_URL: base.DATABASE_URL,
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
      ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
      SCREEN_PROXY_SECRET: "prod-screen-proxy-secret-with-enough-length",
      SANDBOX_PROVIDER: "e2b",
      API_HOST: "0.0.0.0",
    });
    expect(env.authSecret).toBe("prod-auth-secret-with-enough-length");
    expect(env.encryptionKey).toBe("prod-encryption-key-with-enough-length");
    expect(env.sandboxSupervisorToken).toBeUndefined();
    expect(env.screenProxySecret).toBe("prod-screen-proxy-secret-with-enough-length");
    expect(env.apiHost).toBe("0.0.0.0");
  });

  it("falls back to none in production when Docker has no supervisor token", () => {
    const env = loadEnv({
      DATABASE_URL: base.DATABASE_URL,
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
      ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
      SCREEN_PROXY_SECRET: "prod-screen-proxy-secret-with-enough-length",
      SANDBOX_PROVIDER: "docker",
    });
    expect(env.sandboxProvider).toBe("none");
    expect(env.sandboxSupervisorToken).toBeUndefined();
  });

  it("requires a dedicated supervisor token when Docker stays selected", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: base.DATABASE_URL,
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
        ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
        SCREEN_PROXY_SECRET: "prod-screen-proxy-secret-with-enough-length",
        SANDBOX_PROVIDER: "docker",
        SANDBOX_SUPERVISOR_TOKEN: "too-short",
      }),
    ).toThrow(/SANDBOX_SUPERVISOR_TOKEN/);
  });

  it("exposes a deployed git revision when GIT_SHA is set", () => {
    expect(loadEnv(base).gitSha).toBeUndefined();
    expect(loadEnv({ ...base, GIT_SHA: "  3c6e209  " }).gitSha).toBe("3c6e209");
    expect(loadEnv({ ...base, NOVA_GIT_SHA: "abc1234" }).gitSha).toBe("abc1234");
  });

  it("loads SMTP configuration and keeps the email emulator out of production", () => {
    expect(
      loadEnv({
        ...base,
        SMTP_URL: " smtps://user:secret@smtp.example.test:465 ",
        EMAIL_FROM: " Nova <no-reply@example.test> ",
        EMAIL_EMULATOR: "true",
      }),
    ).toMatchObject({
      smtpUrl: "smtps://user:secret@smtp.example.test:465",
      emailFrom: "Nova <no-reply@example.test>",
      emailEmulator: true,
    });
    expect(
      loadEnv({
        ...base,
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
        ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
        SCREEN_PROXY_SECRET: "prod-screen-proxy-secret-with-enough-length",
        SANDBOX_PROVIDER: "none",
        EMAIL_EMULATOR: "true",
      }).emailEmulator,
    ).toBe(false);
    expect(loadEnv({ ...base, NODE_ENV: "development" }).nodeEnv).toBe("development");
  });

  it("defaults the remote MCP private-endpoint escape to off", () => {
    expect(loadEnv(base).mcpAllowPrivateEndpoint).toBe(false);
    expect(loadEnv({ ...base, MCP_ALLOW_PRIVATE_ENDPOINT: "true" }).mcpAllowPrivateEndpoint).toBe(
      true,
    );
    expect(loadEnv({ ...base, MCP_ALLOW_PRIVATE_ENDPOINT: "1" }).mcpAllowPrivateEndpoint).toBe(
      false,
    );
  });
});
