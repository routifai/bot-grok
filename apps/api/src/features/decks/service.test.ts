import type { PrismaClient } from "@nova/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { engineExportDeck } from "./service.js";

const client = {
  baseUrl: "http://engine.test",
  proxySecret: "proxy",
  secrets: [],
  tenant: "space-1",
};
const actor = { userId: "user-1", spaceId: "space-1" } as never;
const prisma = {
  user: { findUnique: vi.fn(async () => ({ email: "p@example.test" })) },
} as unknown as PrismaClient;
const deps = { prisma };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const row = {
  id: "a2",
  parent_session_id: "sess-1",
  name: "q3.pptx",
  title: "Q3 (PowerPoint)",
  kind: "pptx",
  mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  size: 900,
  version: 1,
  versions: 1,
  published: false,
  created_at: 1_700_000_000,
  updated_at: null,
};

afterEach(() => vi.unstubAllGlobals());

describe("engine deck export", () => {
  it("posts the format and returns the new artifact", async () => {
    const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => {
      expect(url.pathname).toBe("/v1/decks/a1/export");
      expect(init?.method).toBe("POST");
      return json(row);
    });
    vi.stubGlobal("fetch", fetchMock);
    const created = await engineExportDeck(deps, client, actor, {
      artifactId: "a1",
      format: "pptx",
    });
    expect(created).toMatchObject({ id: "a2", name: "q3.pptx" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ format: "pptx" });
  });

  it("says the Computer is starting when the engine has no runner", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: { code: "runner_unavailable", message: "starting" } }, 503)),
    );
    await expect(
      engineExportDeck(deps, client, actor, { artifactId: "a1", format: "pdf" }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("maps a refusal to BAD_REQUEST and a missing deck to NOT_FOUND", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ error: { code: "invalid_input", message: "That file isn't a deck" } }, 400),
      ),
    );
    await expect(
      engineExportDeck(deps, client, actor, { artifactId: "a1", format: "pdf" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "That file isn't a deck" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: { code: "not_found", message: "Artifact not found" } }, 404)),
    );
    await expect(
      engineExportDeck(deps, client, actor, { artifactId: "a1", format: "pdf" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
