import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { userMayAct } from "./user-gate.js";

function prismaFor(
  user: { status: string; emailVerified: boolean } | null,
  mode: {
    signupMode: string;
    signupPolicyInitialized: boolean;
    emailDelivery?: boolean;
  } | null = null,
) {
  return {
    user: { findUnique: vi.fn(async () => user) },
    deploymentSettings: { findUnique: vi.fn(async () => mode) },
  } as unknown as PrismaClient;
}

const rule = { devFlagAllowed: false };

describe("userMayAct", () => {
  it("refuses a missing, pending or suspended account whatever else is true", async () => {
    expect(await userMayAct(prismaFor(null), "u", rule)).toBe(false);
    for (const status of ["pending", "suspended"]) {
      expect(await userMayAct(prismaFor({ status, emailVerified: true }), "u", rule)).toBe(false);
    }
  });

  it("lets an active, verified account act", async () => {
    expect(await userMayAct(prismaFor({ status: "active", emailVerified: true }), "u", rule)).toBe(
      true,
    );
  });

  it("lets an unverified one act only with no mail and approval mode, or the personal flag", async () => {
    const unverified = { status: "active", emailVerified: false };
    const approval = { signupMode: "approval", signupPolicyInitialized: true };
    expect(await userMayAct(prismaFor(unverified, approval), "u", rule)).toBe(true);
    expect(
      await userMayAct(prismaFor(unverified, { ...approval, emailDelivery: true }), "u", rule),
    ).toBe(false);
    expect(
      await userMayAct(prismaFor(unverified, { ...approval, signupMode: "open" }), "u", rule),
    ).toBe(false);
    expect(
      await userMayAct(
        prismaFor(unverified, { ...approval, signupPolicyInitialized: false }),
        "u",
        rule,
      ),
    ).toBe(false);
    expect(await userMayAct(prismaFor(unverified, null), "u", { devFlagAllowed: true })).toBe(true);
  });
});
