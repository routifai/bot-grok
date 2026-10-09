import type { SandboxProvider } from "@nova/adapter-kit";
import type { PrismaClient } from "@nova/db";
import { describe, expect, it, vi } from "vitest";
import {
  destroyPersonalComputers,
  destroySpaceComputers,
  stopSpaceComputers,
} from "./space-computers.js";

type Row = {
  id: string;
  spaceId: string;
  providerRef: string | null;
  state: string;
  scope?: string;
  homeKey?: string;
  kind?: string;
  userId?: string;
  screenUrl?: string;
};

function fixture(computers: Row[]) {
  const rows: Row[] = computers.map((row) => ({
    homeKey: "home",
    kind: "fake",
    userId: "u1",
    screenUrl: "x",
    ...row,
  }));
  const update = vi.fn(async ({ where, data }: { where: { id: string }; data: object }) => {
    Object.assign(rows.find((row) => row.id === where.id)!, data);
  });
  const prisma = {
    computer: {
      findMany: vi.fn(async ({ where }: { where: { spaceId: { in: string[] } } }) =>
        rows.filter((row) => where.spaceId.in.includes(String(row.spaceId)) && row.providerRef),
      ),
      update,
    },
  } as unknown as PrismaClient;
  const sandbox = {
    stop: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
  } as unknown as SandboxProvider;
  return { prisma, sandbox, rows };
}

describe("space Computers", () => {
  it("destroys every Computer in the spaces, team and group scope alike, and clears the reference", async () => {
    const { prisma, sandbox, rows } = fixture([
      { id: "c1", spaceId: "s1", scope: "team", providerRef: "team:s1", state: "running" },
      { id: "c2", spaceId: "s1", scope: "group", providerRef: "group:g1", state: "stopped" },
      { id: "c3", spaceId: "other", scope: "team", providerRef: "team:other", state: "running" },
    ]);
    await destroySpaceComputers({ prisma, sandbox }, ["s1"], "test");
    expect(sandbox.destroy).toHaveBeenCalledTimes(2);
    expect(rows.find((row) => row.id === "c1")).toMatchObject({
      providerRef: null,
      state: "stopped",
    });
    expect(rows.find((row) => row.id === "c2")).toMatchObject({ providerRef: null });
    expect(rows.find((row) => row.id === "c3")).toMatchObject({ providerRef: "team:other" });
  });

  it("throws when a destroy fails, so the rows that point at the container are not erased", async () => {
    const { prisma, sandbox, rows } = fixture([
      { id: "c1", spaceId: "s1", providerRef: "team:s1", state: "running" },
    ]);
    vi.mocked(sandbox.destroy).mockRejectedValueOnce(new Error("provider down"));
    await expect(destroySpaceComputers({ prisma, sandbox }, ["s1"], "test")).rejects.toThrow(
      /provider down/,
    );
    expect(rows[0]!.providerRef).toBe("team:s1");
  });

  it("stops running Computers without destroying them or their references", async () => {
    const { prisma, sandbox, rows } = fixture([
      { id: "c1", spaceId: "s1", providerRef: "team:s1", state: "running" },
      { id: "c2", spaceId: "s1", providerRef: "group:g1", state: "stopped" },
    ]);
    await stopSpaceComputers({ prisma, sandbox }, ["s1"], "test");
    expect(sandbox.stop).toHaveBeenCalledTimes(1);
    expect(sandbox.destroy).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ state: "stopped", providerRef: "team:s1" });
  });

  it("account deletion destroys the team Computer in the person's own spaces only", async () => {
    const { prisma, sandbox, rows } = fixture([
      { id: "c1", spaceId: "mine", scope: "team", providerRef: "team:mine", state: "running" },
      { id: "c2", spaceId: "shared", scope: "team", providerRef: "team:shared", state: "running" },
    ]);
    Object.assign(prisma, {
      member: {
        findMany: vi.fn(async () => [
          {
            organizationId: "org-mine",
            organization: { members: [{ userId: "u1" }], spaces: [{ id: "mine" }] },
          },
          {
            organizationId: "org-shared",
            organization: {
              members: [{ userId: "u1" }, { userId: "u2" }],
              spaces: [{ id: "shared" }],
            },
          },
        ]),
      },
    });
    await destroyPersonalComputers({ prisma, sandbox }, "u1");
    expect(sandbox.destroy).toHaveBeenCalledTimes(1);
    expect(rows.find((row) => row.id === "c1")!.providerRef).toBeNull();
    expect(rows.find((row) => row.id === "c2")!.providerRef).toBe("team:shared");
  });

  it("stops each Computer on its own: one failure does not leave the others running", async () => {
    const { prisma, sandbox, rows } = fixture([
      { id: "c1", spaceId: "s1", providerRef: "team:s1", state: "running" },
      { id: "c2", spaceId: "s1", providerRef: "group:g1", state: "running" },
    ]);
    vi.mocked(sandbox.stop).mockRejectedValueOnce(new Error("provider down"));
    await expect(stopSpaceComputers({ prisma, sandbox }, ["s1"], "test")).rejects.toThrow(
      /c1: provider down/,
    );
    expect(sandbox.stop).toHaveBeenCalledTimes(2);
    // The one that failed stays "running": that is what the hourly retry looks for.
    expect(rows.find((row) => row.id === "c1")!.state).toBe("running");
    expect(rows.find((row) => row.id === "c2")!.state).toBe("stopped");
  });
});
