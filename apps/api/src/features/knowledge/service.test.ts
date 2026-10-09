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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("engine knowledge", () => {
  it("maps each file's index state to the camelCase shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        expect(url.pathname).toBe("/v1/knowledge/status");
        return json({
          files: [
            {
              artifact_id: "a".repeat(32),
              name: "report.pdf",
              kind: "pdf",
              state: "searchable",
              search: "keyword",
              keyword_only_reason: "no_connection",
              pages: 12,
              pages_without_text: 2,
              error: null,
            },
          ],
          embeddings: { available: false, reason: "no_connection" },
        });
      }),
    );
    expect(await engineKnowledgeStatus(deps, client, actor)).toEqual({
      files: [
        {
          artifactId: "a".repeat(32),
          name: "report.pdf",
          kind: "pdf",
          state: "searchable",
          search: "keyword",
          keywordOnlyReason: "no_connection",
          pages: 12,
          pagesWithoutText: 2,
          error: null,
        },
      ],
      embeddings: { available: false, reason: "no_connection" },
    });
  });

  it("searches with the caller's identity and maps the passages", async () => {
    const fetchMock = vi.fn(async () =>
      json({
        mode: "hybrid",
        keyword_only_reason: null,
        files_indexing: 1,
        results: [
          {
            file_name: "report.pdf",
            artifact_id: "a".repeat(32),
            page: 3,
            page_end: 3,
            score: 0.8,
            heading: "Risks",
            passage: "Currency exposure",
            thumbnail_url: "/v1/knowledge/files/x/pages/3/thumbnail",
          },
          {
            file_name: "notes.md",
            artifact_id: "b".repeat(32),
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
    vi.stubGlobal("fetch", fetchMock);
    const found = await engineKnowledgeSearch(deps, client, actor, {
      query: "currency",
      fileIds: ["a".repeat(32)],
      k: 4,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/v1/knowledge/search");
    expect(JSON.parse(String(init.body))).toEqual({
      query: "currency",
      file_ids: ["a".repeat(32)],
      k: 4,
    });
    expect(found.filesIndexing).toBe(1);
    expect(found.results.map((hit) => [hit.fileName, hit.page, hit.hasThumbnail])).toEqual([
      ["report.pdf", 3, true],
      ["notes.md", 1, false],
    ]);
  });

  it("returns a page thumbnail as base64 webp and maps a missing page to not found", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        calls.push(url.pathname);
        if (url.pathname.endsWith("/pages/9/thumbnail")) {
          return new Response("nope", { status: 404 });
        }
        return new Response(new Uint8Array([82, 73, 70, 70]), { status: 200 });
      }),
    );
    const id = "a".repeat(32);
    const thumb = await engineKnowledgePageThumbnail(deps, client, actor, {
      artifactId: id,
      page: 2,
    });
    expect(thumb).toEqual({ contentBase64: "UklGRg==", mimeType: "image/webp" });
    expect(calls[0]).toBe(`/v1/knowledge/files/${id}/pages/2/thumbnail`);
    await expect(
      engineKnowledgePageThumbnail(deps, client, actor, { artifactId: id, page: 9 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("asks the engine to re-embed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        expect(url.pathname).toBe("/v1/knowledge/reindex");
        expect(init?.method).toBe("POST");
        return json({ queued: 3 });
      }),
    );
    expect(await engineKnowledgeReindex(deps, client, actor)).toEqual({ queued: 3 });
  });
});
