import { describe, expect, it } from "vitest";
import {
  DEV_AUTH_SECRET_PLACEHOLDER,
  DEV_ENCRYPTION_KEY_PLACEHOLDER,
  DEV_SUPERVISOR_TOKEN_PLACEHOLDER,
  hasValidBearerToken,
  resolveAuthSecret,
  resolveEncryptionKey,
  resolveSupervisorToken,
  timingSafeStringEqual,
} from "./secrets-guard.js";

describe("secrets-guard", () => {
  it("allows placeholders in test mode", () => {
    expect(resolveAuthSecret({ NODE_ENV: "test" })).toBe(DEV_AUTH_SECRET_PLACEHOLDER);
    expect(resolveEncryptionKey({ NODE_ENV: "test" })).toBe(DEV_ENCRYPTION_KEY_PLACEHOLDER);
    expect(resolveSupervisorToken({ NODE_ENV: "test" })).toBe(DEV_SUPERVISOR_TOKEN_PLACEHOLDER);
  });

  it("rejects missing secrets outside local/test", () => {
    expect(() => resolveAuthSecret({ NODE_ENV: "production" })).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => resolveEncryptionKey({ NODE_ENV: "production" })).toThrow(/ENCRYPTION_KEY/);
    expect(() => resolveSupervisorToken({ NODE_ENV: "production" })).toThrow(
      /SANDBOX_SUPERVISOR_TOKEN/,
    );
  });

  it("rejects placeholder values outside local/test", () => {
    expect(() =>
      resolveAuthSecret({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: DEV_AUTH_SECRET_PLACEHOLDER,
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);
    expect(() =>
      resolveEncryptionKey({
        NODE_ENV: "production",
        ENCRYPTION_KEY: DEV_ENCRYPTION_KEY_PLACEHOLDER,
      }),
    ).toThrow(/ENCRYPTION_KEY/);
    expect(() =>
      resolveSupervisorToken({
        NODE_ENV: "production",
        SANDBOX_SUPERVISOR_TOKEN: DEV_SUPERVISOR_TOKEN_PLACEHOLDER,
      }),
    ).toThrow(/SANDBOX_SUPERVISOR_TOKEN/);
    expect(() =>
      resolveSupervisorToken({
        NODE_ENV: "production",
        SANDBOX_SUPERVISOR_TOKEN: "replace-with-32-plus-character-supervisor-token",
      }),
    ).toThrow(/SANDBOX_SUPERVISOR_TOKEN/);
  });

  it("rejects blank and whitespace-padded placeholder secrets in production", () => {
    expect(() => resolveAuthSecret({ NODE_ENV: "production", BETTER_AUTH_SECRET: "   " })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
    expect(() => resolveEncryptionKey({ NODE_ENV: "production", ENCRYPTION_KEY: "\t" })).toThrow(
      /ENCRYPTION_KEY/,
    );
    expect(() =>
      resolveAuthSecret({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: ` ${DEV_AUTH_SECRET_PLACEHOLDER}\n`,
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);
    expect(() =>
      resolveEncryptionKey({
        NODE_ENV: "production",
        ENCRYPTION_KEY: `${DEV_ENCRYPTION_KEY_PLACEHOLDER} `,
      }),
    ).toThrow(/ENCRYPTION_KEY/);
  });

  it("does not treat disabled Vitest flags as a test environment", () => {
    expect(() => resolveAuthSecret({ NODE_ENV: "production", VITEST: "0" })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
    expect(() => resolveEncryptionKey({ NODE_ENV: "production", VITEST: "false" })).toThrow(
      /ENCRYPTION_KEY/,
    );
  });

  it("accepts real dedicated credentials in production", () => {
    expect(
      resolveSupervisorToken({
        NODE_ENV: "production",
        SANDBOX_SUPERVISOR_TOKEN: "prod-supervisor-token-with-enough-length",
      }),
    ).toBe("prod-supervisor-token-with-enough-length");
  });

  it("accepts real secrets in production", () => {
    expect(
      resolveAuthSecret({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "prod-secret-with-enough-entropy-here",
      }),
    ).toBe("prod-secret-with-enough-entropy-here");
    expect(
      resolveEncryptionKey({
        NODE_ENV: "production",
        ENCRYPTION_KEY: "prod-encryption-key-with-enough-entropy",
      }),
    ).toBe("prod-encryption-key-with-enough-entropy");
  });

  it("keeps an existing non-placeholder encryption key usable during upgrades", () => {
    expect(resolveEncryptionKey({ NODE_ENV: "production", ENCRYPTION_KEY: "existing-key" })).toBe(
      "existing-key",
    );
  });

  it("requires a dedicated supervisor credential", () => {
    expect(
      resolveSupervisorToken({
        NODE_ENV: "test",
        SANDBOX_SUPERVISOR_TOKEN: "supervisor-only",
        BETTER_AUTH_SECRET: "custom-auth",
      }),
    ).toBe("supervisor-only");
    expect(() =>
      resolveSupervisorToken({
        NODE_ENV: "test",
        SANDBOX_SUPERVISOR_TOKEN: "custom-auth",
        BETTER_AUTH_SECRET: "custom-auth",
      }),
    ).toThrow(/must differ/);
    expect(() =>
      resolveSupervisorToken({
        NODE_ENV: "production",
        SANDBOX_SUPERVISOR_TOKEN: "too-short",
      }),
    ).toThrow(/at least 32 characters/);
  });

  it("compares raw strings in constant time", () => {
    expect(timingSafeStringEqual("secret-token", "secret-token")).toBe(true);
    expect(timingSafeStringEqual("secret-token-longer", "secret-token")).toBe(false);
    expect(timingSafeStringEqual("secret-toke", "secret-token")).toBe(false);
    expect(timingSafeStringEqual("Secret-token", "secret-token")).toBe(false);
    expect(timingSafeStringEqual(undefined, "secret-token")).toBe(false);
    expect(timingSafeStringEqual("", "")).toBe(true);
  });

  it("compares bearer tokens without leaking a length or a prefix match", () => {
    expect(hasValidBearerToken("Bearer secret-token", "secret-token")).toBe(true);
    expect(hasValidBearerToken("Bearer secret-token-longer", "secret-token")).toBe(false);
    expect(hasValidBearerToken("Bearer secret-toke", "secret-token")).toBe(false);
    expect(hasValidBearerToken("secret-token", "secret-token")).toBe(false);
    expect(hasValidBearerToken("Basic secret-token", "secret-token")).toBe(false);
    expect(hasValidBearerToken(undefined, "secret-token")).toBe(false);
  });
});
