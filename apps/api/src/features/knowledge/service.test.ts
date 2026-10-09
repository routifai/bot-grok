import type { PrismaClient } from "@nova/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  engineKnowledgePageThumbnail,
  engineKnowledgeReindex,
  engineKnowledgeSearch,
  engineKnowledgeStatus,
} from "./service.js";

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
const FILE = "f".repeat(32);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Answers `/v1/me/muse` with the Muse session, everything else with `handler`. */
function engine(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (url: URL, init?: RequestInit) =>
    url.pathname === "/v1/me/muse"
      ? json({ session_id: "sess-1", agent: "agent", created: false })
      : handler(url, init),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("engine knowledge", () => {
  it("maps the Muse session's file states to the camelCase shape", async () => {
    engine((url) => {
      expect(url.pathname).toBe("/v1/sessions/sess-1/knowledge/status");
      return json({
        files: [
          {
            file_id: FILE,
            path: "your_files/uploads/2026-10-09/report.pdf",
            name: "report.pdf",
            kind: "pdf",
            state: "searchable",
            search: "keyword",
            keyword_only_reason: "no_connection",
            pages: 12,
            pages_without_text: 2,
            error: null,
            artifact_id: null,
          },
        ],
        embeddings: { available: false, reason: "no_connection" },
        computer: "asleep",
        updated_at: 1760000000,
      });
    });
    expect(await engineKnowledgeStatus(deps, client, actor)).toEqual({
      files: [
        {
          fileId: FILE,
          path: "your_files/uploads/2026-10-09/report.pdf",
          name: "report.pdf",
          kind: "pdf",
          state: "searchable",
          search: "keyword",
          keywordOnlyReason: "no_connection",
          pages: 12,
          pagesWithoutText: 2,
          error: null,
          artifactId: null,
        },
      ],
      embeddings: { available: false, reason: "no_connection" },
      computer: "asleep",
      updatedAt: 1760000000,
    });
  });

  it("searches the Muse session and maps the passages", async () => {
    const fetchMock = engine(() =>
      json({
        mode: "hybrid",
        keyword_only_reason: null,
        files_indexing: 1,
        files_indexing_names: ["new.pdf"],
        results: [
          {
            file_id: FILE,
            path: "your_files/uploads/d/report.pdf",
            file_name: "report.pdf",
            artifact_id: "a".repeat(32),
            page: 3,
            page_end: 3,
            score: 0.8,
            heading: "Risks",
            passage: "Currency exposure",
            thumbnail_url: "/x",
          },
          {
            file_id: "e".repeat(32),
            path: "your_files/notes.md",
            file_name: "notes.md",
            artifact_id: null,
            page: 1,
            page_end: 1,
            score: 0.4,
            heading: "",
            passage: "text",
            thumbnail_url: null,
          },
        ],
      }),
    );
    const found = await engineKnowledgeSearch(deps, client, actor, {
      query: "currency",
      fileIds: [FILE],
      k: 4,
    });
    const [url, init] = fetchMock.mock.calls[1] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/v1/sessions/sess-1/knowledge/search");
    expect(JSON.parse(String(init.body))).toEqual({ query: "currency", file_ids: [FILE], k: 4 });
    expect(found.filesIndexing).toBe(1);
    expect(found.filesIndexingNames).toEqual(["new.pdf"]);
    expect(
      found.results.map((hit) => [hit.fileName, hit.fileId, hit.artifactId, hit.hasThumbnail]),
    ).toEqual([
      ["report.pdf", FILE, "a".repeat(32), true],
      ["notes.md", "e".repeat(32), null, false],
    ]);
  });

  it("returns a page thumbnail by file id and maps a missing page to not found", async () => {
    const calls: string[] = [];
    engine((url) => {
      calls.push(url.pathname);
      if (url.pathname.endsWith("/pages/9/thumbnail")) return new Response("nope", { status: 404 });
      return new Response(new Uint8Array([82, 73, 70, 70]), { status: 200 });
    });
    const thumb = await engineKnowledgePageThumbnail(deps, client, actor, {
      fileId: FILE,
      page: 2,
    });
    expect(thumb).toEqual({ contentBase64: "UklGRg==", mimeType: "image/webp" });
    expect(calls[0]).toBe(`/v1/sessions/sess-1/knowledge/files/${FILE}/pages/2/thumbnail`);
    await expect(
      engineKnowledgePageThumbnail(deps, client, actor, { fileId: FILE, page: 9 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("asks the Muse session to re-embed", async () => {
    engine((url, init) => {
      expect(url.pathname).toBe("/v1/sessions/sess-1/knowledge/reindex");
      expect(init?.method).toBe("POST");
      return json({ queued: 3 });
    });
    expect(await engineKnowledgeReindex(deps, client, actor)).toEqual({ queued: 3 });
  });
});
