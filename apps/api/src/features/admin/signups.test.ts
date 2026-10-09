import { bootstrapUserSpace } from "@nova/db";
import type { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  approveSignup,
  pendingSignups,
  rejectSignup,
  signupSettings,
  updateSignupSettings,
} from "./signups.js";

vi.mock("@nova/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  bootstrapUserSpace: vi.fn(async () => ({ spaceId: "space-1" })),
}));

const owner = { userId: "owner", spaceId: "s1", isDeploymentOwner: true } as never;
const member = { userId: "member", spaceId: "s1", isDeploymentOwner: false } as never;

function fixture(identity?: { production: boolean; emailDelivery: boolean }) {
  const settings = {
    signupMode: "approval",
    signupAllowlist: "",
    signupDomains: "corp.test",
    signupPolicyInitialized: true,
  };
  const users = [
    { id: "u1", email: "a@corp.test", name: "A", status: "pending", emailVerified: true },
    { id: "u2", email: "b@corp.test", name: "B", status: "pending", emailVerified: false },
    { id: "u3", email: "c@corp.test", name: "C", status: "active", emailVerified: true },
  ].map((user) => ({ ...user, createdAt: new Date("2026-01-01T00:00:00Z") }));
  const prisma = {
    deploymentSettings: {
      findUnique: vi.fn(async () => settings),
      upsert: vi.fn(async ({ update }: { update: Partial<typeof settings> }) => {
        Object.assign(settings, update);
      }),
    },
    user: {
      findMany: vi.fn(async ({ where }: { where: { status: string; emailVerified?: boolean } }) =>
        users.filter(
          (user) =>
            user.status === where.status &&
            (where.emailVerified === undefined || user.emailVerified === where.emailVerified),
        ),
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; status: string };
          data: { status: string };
        }) => {
          const user = users.find((item) => item.id === where.id && item.status === where.status);
          if (!user) return { count: 0 };
          user.status = data.status;
          return { count: 1 };
        },
      ),
    },
  };
  return {
    deps: { prisma: prisma as never, identity: identity && { ...identity, signupPolicy: {} } },
    settings,
    users,
  };
}

async function rejection(promise: Promise<unknown>): Promise<ORPCError<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    return error as ORPCError<string, unknown>;
  }
  throw new Error("expected a rejection");
}

beforeEach(() => vi.clearAllMocks());

describe("signup administration", () => {
  it("is for the deployment owner only", async () => {
    const { deps } = fixture();
    for (const call of [
      signupSettings(deps, member),
      updateSignupSettings(deps, member, { mode: "open" }),
      pendingSignups(deps, member),
      approveSignup(deps, member, "u1"),
      rejectSignup(deps, member, "u1"),
    ]) {
      expect((await rejection(call)).code).toBe("FORBIDDEN");
    }
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
  });

  it("lists who waits, and with mail delivery only those who proved their mailbox", async () => {
    expect((await pendingSignups(fixture().deps, owner)).map((p) => p.userId)).toEqual([
      "u1",
      "u2",
    ]);
    const mailed = fixture({ production: false, emailDelivery: true });
    expect((await pendingSignups(mailed.deps, owner)).map((p) => p.userId)).toEqual(["u1"]);
  });

  it("approves once: activates, then provisions without taking the owner seat", async () => {
    const { deps, users } = fixture();
    await approveSignup(deps, owner, "u1");
    expect(users[0]!.status).toBe("active");
    expect(bootstrapUserSpace).toHaveBeenCalledWith(
      expect.anything(),
      { id: "u1" },
      expect.anything(),
      {
        claimDeploymentOwner: false,
      },
    );
    expect((await rejection(approveSignup(deps, owner, "u1"))).code).toBe("NOT_FOUND");
    expect((await rejection(approveSignup(deps, owner, "u3"))).code).toBe("NOT_FOUND");
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
  });

  it("rejects by suspending, with no provisioning", async () => {
    const { deps, users } = fixture();
    await rejectSignup(deps, owner, "u1");
    expect(users[0]!.status).toBe("suspended");
    expect((await rejection(rejectSignup(deps, owner, "u1"))).code).toBe("NOT_FOUND");
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
  });

  it("edits mode, invites and domains, normalizing the lists", async () => {
    const { deps, settings } = fixture();
    expect(await signupSettings(deps, owner)).toEqual({
      mode: "approval",
      invites: [],
      domains: ["corp.test"],
    });
    const next = await updateSignupSettings(deps, owner, {
      mode: "invite",
      invites: [" Ada@Corp.test ", "@other.test"],
      domains: ["@Corp.test", "nonsense"],
    });
    expect(next).toEqual({
      mode: "invite",
      invites: ["ada@corp.test", "@other.test"],
      domains: ["corp.test"],
    });
    expect(settings.signupMode).toBe("invite");
  });

  it("will not open signup in production without email delivery, but allows closing it", async () => {
    const { deps } = fixture({ production: true, emailDelivery: false });
    expect((await rejection(updateSignupSettings(deps, owner, { mode: "open" }))).code).toBe(
      "BAD_REQUEST",
    );
    await expect(updateSignupSettings(deps, owner, { mode: "closed" })).resolves.toMatchObject({
      mode: "closed",
    });
  });
});
