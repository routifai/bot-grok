import { createCipheriv, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { EncryptedSecretStore } from "./secrets.js";

describe("secret store", () => {
  it("round-trips and never stores plaintext in ciphertext", async () => {
    const store = new EncryptedSecretStore("test-key");
    const record = await store.put("sk-or-v1-secretvalue", {
      operationId: "1",
      traceId: "1",
      spaceId: "w",
      userId: "u",
      signal: new AbortController().signal,
    });
    expect(record.ciphertext).not.toContain("sk-or-v1-secretvalue");
    expect(record.ciphertext).toMatch(/^v2:/);
    expect(store.load(record.ciphertext, record.id)).toBe("sk-or-v1-secretvalue");
    expect(() => store.load(record.ciphertext, "another-row")).toThrow();
  });

  it("keeps legacy ciphertext readable without rewriting it at startup", () => {
    const key = "legacy-test-key";
    const iv = Buffer.alloc(12, 7);
    const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(key).digest(), iv);
    const encrypted = Buffer.concat([cipher.update("legacy-secret", "utf8"), cipher.final()]);
    const legacy = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
    const store = new EncryptedSecretStore(key);
    expect(store.load(legacy, "secret-row")).toBe("legacy-secret");
  });
});

describe("fake sandbox", () => {
  it("provisions isolated computers", async () => {
    const sandbox = new FakeSandboxProvider();
    const ctx = {
      operationId: "1",
      traceId: "1",
      spaceId: "w",
      userId: "u",
      signal: new AbortController().signal,
    };
    const a = await sandbox.provision({ botId: "a", homePath: "/tmp/a" }, ctx);
    const b = await sandbox.provision({ botId: "b", homePath: "/tmp/b" }, ctx);
    expect(a.id).not.toBe(b.id);
  });
});
