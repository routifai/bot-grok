import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { userMayAct } from "./user-gate.js";

function prismaFor(
  user: { status: string; emailVerified: boolean } | null,
  mode: { signupMode: string; signupPolicyInitialized: boolean } | null = null,
) {
  return {
    user: { findUnique: vi.fn(async () => user) },
    deploymentSettings: { findUnique: vi.fn(async () => mode) },
  } as unknown as PrismaClient;
}

const noMail = { hasEmailDelivery: false, devFlagAllowed: false };
const withMail = { hasEmailDelivery: true, devFlagAllowed: false };

describe("userMayAct", () => {
  it("refuses a missing, pending or suspended account whatever else is true", async () => {
    expect(await userMayAct(prismaFor(null), "u", noMail)).toBe(false);
    for (const status of ["pending", "suspended"]) {
      expect(await userMayAct(prismaFor({ status, emailVerified: true }), "u", noMail)).toBe(false);
    }
  });

  it("lets an active, verified account act", async () => {
    expect(
      await userMayAct(prismaFor({ status: "active", emailVerified: true }), "u", withMail),
    ).toBe(true);
  });

  it("lets an unverified one act only with no mail and approval mode, or the personal flag", async () => {
    const unverified = { status: "active", emailVerified: false };
    const approval = { signupMode: "approval", signupPolicyInitialized: true };
    expect(await userMayAct(prismaFor(unverified, approval), "u", noMail)).toBe(true);
    expect(await userMayAct(prismaFor(unverified, approval), "u", withMail)).toBe(false);
    expect(
      await userMayAct(prismaFor(unverified, { ...approval, signupMode: "open" }), "u", noMail),
    ).toBe(false);
    expect(
      await userMayAct(
        prismaFor(unverified, { ...approval, signupPolicyInitialized: false }),
        "u",
        noMail,
      ),
    ).toBe(false);
    expect(
      await userMayAct(prismaFor(unverified, null), "u", { ...noMail, devFlagAllowed: true }),
    ).toBe(true);
  });
});
