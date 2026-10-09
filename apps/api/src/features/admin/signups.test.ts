import { purgeQuarantinedOrganizations } from "@nova/adapters";
import {
  bootstrapUserSpace,
  quarantinedOrganizationsToPurge,
  restoreQuarantinedSpaces,
} from "@nova/db";
import type { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetEngineAccount, setEngineAccountSuspended } from "./service.js";
import {
  approveSignup,
  discardSignup,
  pendingSignups,
  rejectSignup,
  restoreSignup,
  signupSettings,
  updateSignupSettings,
} from "./signups.js";

vi.mock("@nova/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  bootstrapUserSpace: vi.fn(async () => ({ spaceId: "space-1" })),
  restoreQuarantinedSpaces: vi.fn(async () => 1),
  quarantinedOrganizationsToPurge: vi.fn(async () => [{ id: "org-1", spaces: [{ id: "s-1" }] }]),
}));
vi.mock("@nova/adapters", () => ({
  purgeQuarantinedOrganizations: vi.fn(async () => ["org-1"]),
}));
vi.mock("./service.js", () => ({
  resetEngineAccount: vi.fn(async () => "done"),
  setEngineAccountSuspended: vi.fn(async () => "done"),
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
  ].map((user) => ({
    ...user,
    engineQuarantinePaused: user.id === "u1", // u1's space was quarantined and its engine paused
    createdAt: new Date("2026-01-01T00:00:00Z"),
  }));
  const prisma = {
    deploymentSettings: {
      findUnique: vi.fn(async () => settings),
      upsert: vi.fn(async ({ update }: { update: Partial<typeof settings> }) => {
        Object.assign(settings, update);
      }),
    },
    space: {
      aggregate: vi.fn(async () => ({ _min: { createdAt: new Date("2026-09-01T10:00:00Z") } })),
    },
    run: { findFirst: vi.fn(async () => ({ createdAt: new Date("2026-09-20T10:00:00Z") })) },
    bot: { count: vi.fn(async () => 2) },
    user: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          users.find((user) => user.id === where.id) ?? null,
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: object }) => {
        Object.assign(users.find((user) => user.id === where.id)!, data);
      }),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; status: string } }) =>
          users.find((user) => user.id === where.id && user.status === where.status) ?? null,
      ),
      deleteMany: vi.fn(async ({ where }: { where: { id: string; status: string } }) => {
        const index = users.findIndex(
          (user) => user.id === where.id && user.status === where.status,
        );
        if (index < 0) return { count: 0 };
        users.splice(index, 1);
        return { count: 1 };
      }),
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
  const quotaWrites: string[] = [];
  Object.assign(prisma, {
    organization: {
      findMany: vi.fn(async ({ where }: { where: { quarantinedFromUserId: { in: string[] } } }) =>
        where.quarantinedFromUserId.in.includes("u1") ? [{ quarantinedFromUserId: "u1" }] : [],
      ),
    },
    $queryRaw: vi.fn(async (_strings: TemplateStringsArray, key: string) => {
      quotaWrites.push(key);
      return [{ count: 1 }];
    }),
  });
  const deleteUser = vi.fn(async (id: string) => {
    users.splice(
      users.findIndex((user) => user.id === id),
      1,
    );
  });
  return {
    deps: {
      prisma: prisma as never,
      identity: identity && { ...identity, signupPolicy: {} },
      auth: { $context: Promise.resolve({ internalAdapter: { deleteUser } }) } as never,
      sandbox: {} as never,
    },
    settings,
    users,
    deleteUser,
    quotaWrites,
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

  it("lists everyone who waits, unverified rows included and marked", async () => {
    const mailed = fixture({ production: false, emailDelivery: true });
    const rows = await pendingSignups(mailed.deps, owner);
    expect(rows.map((p) => [p.userId, p.emailVerified, p.previousSpace !== null])).toEqual([
      ["u1", true, true],
      ["u2", false, false],
    ]);
    expect(rows[0]!.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(rows[0]!.previousSpace).toEqual({
      createdAt: "2026-09-01T10:00:00.000Z",
      lastActive: "2026-09-20T10:00:00.000Z",
      muses: 2,
    });
    expect(rows[1]!.previousSpace).toBeNull();
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

  it("rejects a proven address by suspending it, and removes an unproven one", async () => {
    const { deps, users, deleteUser, quotaWrites } = fixture();
    await rejectSignup(deps, owner, "u1");
    expect(users[0]!.status).toBe("suspended");
    expect(deleteUser).not.toHaveBeenCalled();
    expect((await rejection(rejectSignup(deps, owner, "u1"))).code).toBe("NOT_FOUND");
    // u2 never proved its mailbox: it may be squatting on someone else's address. It is removed
    // through Better Auth and the address cools down so it cannot be re-queued at once.
    await rejectSignup(deps, owner, "u2");
    expect(deleteUser).toHaveBeenCalledWith("u2");
    expect(quotaWrites).toEqual(["rejected:b@corp.test"]);
    expect(users.map((user) => user.id)).toEqual(["u1", "u3"]);
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

  it("restores a kept space and lets the confirmed person in", async () => {
    const { deps, users } = fixture();
    await restoreSignup(deps, owner, "u1");
    expect(restoreQuarantinedSpaces).toHaveBeenCalledWith(expect.anything(), "u1");
    expect(users[0]!.status).toBe("active");
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
    vi.mocked(restoreQuarantinedSpaces).mockResolvedValueOnce(0);
    expect((await rejection(restoreSignup(deps, owner, "u2"))).code).toBe("NOT_FOUND");
    expect(users[1]!.status).toBe("pending");
    expect((await rejection(restoreSignup(deps, member, "u1"))).code).toBe("FORBIDDEN");
  });

  it("discards a kept space through the shared purge, which destroys Computers first", async () => {
    const { deps } = fixture();
    await discardSignup(deps, owner, "u1");
    expect(purgeQuarantinedOrganizations).toHaveBeenCalledWith(
      deps,
      [{ id: "org-1", spaces: [{ id: "s-1" }] }],
      "quarantine-discard:u1",
    );
    vi.mocked(quarantinedOrganizationsToPurge).mockResolvedValueOnce([]);
    expect((await rejection(discardSignup(deps, owner, "u1"))).code).toBe("NOT_FOUND");
    expect((await rejection(discardSignup(deps, member, "u1"))).code).toBe("FORBIDDEN");
  });

  it("resets the engine account on approve, never resuming a quarantined person's context", async () => {
    const { deps, users } = fixture();
    await approveSignup(deps, owner, "u1", {} as never);
    expect(resetEngineAccount).toHaveBeenCalledWith(deps, {}, "a@corp.test");
    expect(setEngineAccountSuspended).not.toHaveBeenCalled();
    expect(users[0]).toMatchObject({ status: "active", engineQuarantinePaused: false });
    // An account that never had a space quarantined has nothing to reset.
    vi.mocked(resetEngineAccount).mockClear();
    await approveSignup(deps, owner, "u2", {} as never);
    expect(resetEngineAccount).not.toHaveBeenCalled();
  });

  it("keeps the flag and refuses to approve when the engine reset fails, so the retry still resets", async () => {
    const { deps, users } = fixture();
    vi.mocked(resetEngineAccount).mockRejectedValueOnce(new Error("engine refused"));
    await expect(approveSignup(deps, owner, "u1", {} as never)).rejects.toThrow(/engine refused/);
    expect(users[0]).toMatchObject({ status: "pending", engineQuarantinePaused: true });
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
  });

  it("still resets after the space is gone (discarded or purged), driven by the flag on the person", async () => {
    const { deps } = fixture();
    vi.mocked(quarantinedOrganizationsToPurge).mockResolvedValue([]);
    await approveSignup(deps, owner, "u1", {} as never);
    expect(resetEngineAccount).toHaveBeenCalledTimes(1);
    vi.mocked(quarantinedOrganizationsToPurge).mockResolvedValue([
      { id: "org-1", spaces: [{ id: "s-1" }] },
    ]);
  });

  it("restore resumes the engine account instead of resetting it", async () => {
    const { deps, users } = fixture();
    await restoreSignup(deps, owner, "u1", {} as never);
    expect(setEngineAccountSuspended).toHaveBeenCalledWith(deps, {}, "a@corp.test", false);
    expect(resetEngineAccount).not.toHaveBeenCalled();
    expect(users[0]!.engineQuarantinePaused).toBe(false);
  });

  it("restore resumes the engine before activating: a refusal leaves the person pending and retryable", async () => {
    const { deps, users } = fixture();
    vi.mocked(setEngineAccountSuspended).mockRejectedValueOnce(new Error("engine refused"));
    await expect(restoreSignup(deps, owner, "u1", {} as never)).rejects.toThrow(/engine refused/);
    expect(users[0]).toMatchObject({ status: "pending", engineQuarantinePaused: true });
    expect(restoreQuarantinedSpaces).not.toHaveBeenCalled();
    await restoreSignup(deps, owner, "u1", {} as never); // the retry succeeds
    expect(users[0]).toMatchObject({ status: "active", engineQuarantinePaused: false });
    expect(restoreQuarantinedSpaces).toHaveBeenCalledTimes(1);
  });

  it("discard resets the engine account after the purge, and not if the purge was partial", async () => {
    const { deps } = fixture();
    await discardSignup(deps, owner, "u1", {} as never);
    expect(resetEngineAccount).toHaveBeenCalledWith(deps, {}, "a@corp.test");
    vi.mocked(resetEngineAccount).mockClear();
    vi.mocked(purgeQuarantinedOrganizations).mockResolvedValueOnce([]);
    expect((await rejection(discardSignup(deps, owner, "u1", {} as never))).code).toBe(
      "INTERNAL_SERVER_ERROR",
    );
    expect(resetEngineAccount).not.toHaveBeenCalled();
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
