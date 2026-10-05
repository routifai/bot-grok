import type { PrismaClient } from "@aiden/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { engineListFiles, engineReadFile, engineSaveFileToLibrary } from "./engine-files.js";

const client = { baseUrl: "http://engine.test", proxySecret: "proxy", secrets: [] };
const actor = { userId: "user-1", spaceId: "space-1" } as never;
const prisma = {
  bot: {
    findFirst: vi.fn(async () => ({ omnigentSession: { omnigentSessionId: "sess-1" } })),
  },
  user: { findUnique: vi.fn(async () => ({ email: "p@example.test" })) },
} as unknown as PrismaClient;
const deps = { prisma };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fileBody = (content: string, extra: Record<string, unknown> = {}) => ({
  object: "session.environment.filesystem.file_content",
  path: "a/b.html",
  encoding: "utf-8",
  content,
  bytes: content.length,
  ...extra,
});

afterEach(() => vi.unstubAllGlobals());

describe("engine files", () => {
  it("lists a directory newest first with the engine's entry shape mapped", async () => {
    const fetchMock = vi.fn(async (url: URL) => {
      expect(url.pathname).toBe("/v1/sessions/sess-1/resources/environments/default/filesystem/a");
      return json({
        data: [
          { name: "old.txt", path: "a/old.txt", type: "file", bytes: 3, modified_at: 10 },
          { name: "sub", path: "a/sub", type: "directory", bytes: null, modified_at: 30 },
          { name: "new.md", path: "a/new.md", type: "file", bytes: 5, modified_at: 20 },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { entries } = await engineListFiles(deps, client, actor, { botId: "bot-1", path: "a/" });
    expect(entries.map((e) => e.name)).toEqual(["sub", "new.md", "old.txt"]);
    expect(entries[0]).toMatchObject({ type: "directory", size: null });
  });

  it("maps an engine 503 (runner still reconnecting) to SERVICE_UNAVAILABLE", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: { code: "runner_unavailable", message: "offline" } }, 503)),
    );
    await expect(
      engineListFiles(deps, client, actor, { botId: "bot-1", path: "" }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("rejects paths that leave the workspace without calling the engine", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const path of ["../etc/passwd", "a/../../x", "/etc/passwd", "~/x", "a\\b"]) {
      await expect(engineReadFile(deps, client, actor, { botId: "bot-1", path })).rejects.toThrow(
        /outside the workspace/,
      );
    }
    await expect(
      engineListFiles(deps, client, actor, { botId: "bot-1", path: ".." }),
    ).rejects.toThrow(/outside the workspace/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads text with its mime and withholds oversized or opaque binary content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(fileBody("<h1>hi</h1>"))),
    );
    const html = await engineReadFile(deps, client, actor, { botId: "bot-1", path: "a/b.html" });
    expect(html).toMatchObject({ name: "b.html", mimeType: "text/html", tooLarge: false });
    expect(Buffer.from(html.contentBase64 ?? "", "base64").toString()).toBe("<h1>hi</h1>");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(fileBody("x", { bytes: 6 * 1024 * 1024 }))),
    );
    const big = await engineReadFile(deps, client, actor, { botId: "bot-1", path: "a/b.txt" });
    expect(big).toMatchObject({ tooLarge: true, contentBase64: null });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          ...fileBody(""),
          encoding: "base64",
          content: Buffer.from([0, 1, 2, 3]).toString("base64"),
        }),
      ),
    );
    const bin = await engineReadFile(deps, client, actor, { botId: "bot-1", path: "a/blob.bin" });
    expect(bin).toMatchObject({ binary: true, contentBase64: null });
  });

  it("saves a workspace file to the Library through POST /v1/artifacts", async () => {
    const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        expect(url.pathname).toBe("/v1/artifacts");
        expect(url.searchParams.get("parent_session_id")).toBe("sess-1");
        expect(url.searchParams.get("name")).toBe("b.html");
        expect((init.body as Uint8Array).length).toBe(11);
        return json(
          {
            id: "a1",
            parent_session_id: "sess-1",
            name: "b.html",
            title: null,
            kind: "html",
            mime: "text/html; charset=utf-8",
            size: 11,
            version: 1,
            versions: 1,
            published: false,
            created_at: 1_700_000_000,
            updated_at: null,
          },
          201,
        );
      }
      return json(fileBody("<h1>hi</h1>"));
    });
    vi.stubGlobal("fetch", fetchMock);
    const artifact = await engineSaveFileToLibrary(deps, client, actor, {
      botId: "bot-1",
      path: "a/b.html",
    });
    expect(artifact).toMatchObject({ id: "a1", botId: "bot-1", mimeType: "text/html", size: 11 });
  });
});
