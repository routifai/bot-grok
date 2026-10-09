import type { PrismaClient } from "@nova/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dedupeUploadName,
  engineIngestAttachment,
  engineListFiles,
  engineReadFile,
  engineSaveFileToLibrary,
  engineUploadAttachment,
  safeUploadName,
} from "./files.js";

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

describe("engine attachment upload", () => {
  const FS = "/v1/sessions/muse-1/resources/environments/default/filesystem";
  const day = new Date("2026-10-09T12:00:00Z");
  const uploadPrisma = {
    bot: { findFirst: vi.fn(async () => ({ id: "bot-1" })) },
    user: { findUnique: vi.fn(async () => ({ email: "p@example.test" })) },
  } as unknown as PrismaClient;
  const upDeps = { prisma: uploadPrisma };
  const input = (over: Record<string, unknown> = {}) => ({
    botId: "bot-1",
    name: "report.pdf",
    mimeType: "application/pdf",
    contentBase64: Buffer.from("%PDF-1.4").toString("base64"),
    ...over,
  });
  const museOr = (
    handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
  ): ReturnType<typeof vi.fn> => {
    const fetchMock = vi.fn(async (url: URL, init?: RequestInit) =>
      url.pathname === "/v1/me/muse"
        ? json({ session_id: "muse-1", agent: "agent", created: false })
        : handler(url, init),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("PUTs base64 under your_files/uploads/<date>/ and returns the path", async () => {
    const fetchMock = museOr((url, init) => {
      if (init?.method === "PUT") return json({ bytes_written: 8, path: "x", created: true });
      expect(url.pathname).toBe(`${FS}/your_files/uploads/2026-10-09`);
      return json({}, 404);
    });
    const out = await engineUploadAttachment(upDeps, client, actor, input(), day);
    expect(out).toEqual({
      path: "your_files/uploads/2026-10-09/report.pdf",
      name: "report.pdf",
      mimeType: "application/pdf",
      size: 8,
    });
    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [URL, RequestInit];
    expect(url.pathname).toBe(`${FS}/your_files/uploads/2026-10-09/report.pdf`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      content: Buffer.from("%PDF-1.4").toString("base64"),
      encoding: "base64",
      create_parents: true,
    });
  });

  it("de-duplicates against the day's folder", async () => {
    museOr((_url, init) =>
      init?.method === "PUT"
        ? json({ bytes_written: 8 })
        : json({
            data: ["report.pdf", "report (2).pdf"].map((name) => ({
              name,
              path: `your_files/uploads/2026-10-09/${name}`,
              type: "file",
              bytes: 1,
              modified_at: 1,
            })),
          }),
    );
    const out = await engineUploadAttachment(upDeps, client, actor, input(), day);
    expect(out.path).toBe("your_files/uploads/2026-10-09/report (3).pdf");
    expect(out.name).toBe("report (3).pdf");
  });

  it("maps a 503 from the engine to the calm starting message", async () => {
    museOr(() => json({ error: { code: "runner_unavailable" } }, 503));
    await expect(engineUploadAttachment(upDeps, client, actor, input(), day)).rejects.toMatchObject(
      {
        code: "SERVICE_UNAVAILABLE",
        message: "Your Computer is starting. Try again in a moment.",
      },
    );
  });

  it("rejects bad types and bad base64 before touching the engine", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      engineUploadAttachment(upDeps, client, actor, input({ mimeType: "application/zip" })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      engineUploadAttachment(upDeps, client, actor, input({ contentBase64: "not base64!" })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("makes names safe and numbers duplicates", () => {
    expect(safeUploadName("../../etc/passwd", "text/plain")).toBe("passwd.txt");
    expect(safeUploadName("..\\x\\.hidden.png", "image/png")).toBe("hidden.png");
    expect(safeUploadName("", "application/pdf")).toBe("file.pdf");
    expect(dedupeUploadName("a.pdf", new Set(["a.pdf"]))).toBe("a (2).pdf");
    expect(dedupeUploadName("noext", new Set(["noext", "noext (2)"]))).toBe("noext (3)");
  });
});

describe("engine attachment ingest", () => {
  const ingestPrisma = {
    bot: { findFirst: vi.fn(async () => ({ id: "bot-1" })) },
    user: { findUnique: vi.fn(async () => ({ email: "p@example.test" })) },
  } as unknown as PrismaClient;
  const ingestDeps = { prisma: ingestPrisma };
  const path = "your_files/uploads/2026-10-09/report.pdf";
  const stub = (handler: (url: URL, init?: RequestInit) => Response) => {
    const fetchMock = vi.fn(async (url: URL, init?: RequestInit) =>
      url.pathname === "/v1/me/muse"
        ? json({ session_id: "muse-1", agent: "agent", created: false })
        : handler(url, init),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("asks the engine to read the file and returns what it came to", async () => {
    const fetchMock = stub(() =>
      json({ file_id: "ab12", name: "report.pdf", pages: 3, chars: 900, markdown_path: "/m.md" }),
    );
    const out = await engineIngestAttachment(ingestDeps, client, actor, { botId: "bot-1", path });
    expect(out).toEqual({ fileId: "ab12", name: "report.pdf", pages: 3, chars: 900 });
    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/v1/sessions/muse-1/knowledge/ingest");
    expect(JSON.parse(String(init.body))).toEqual({ path, inline: false });
  });

  it("only reads uploads, and says calmly when the file can't be read", async () => {
    const fetchMock = stub(() => json({ error: { message: "not a readable PDF" } }, 400));
    await expect(
      engineIngestAttachment(ingestDeps, client, actor, { botId: "bot-1", path: "secrets/x.pdf" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      engineIngestAttachment(ingestDeps, client, actor, { botId: "bot-1", path }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Nova couldn't read this file." });
  });

  it("maps a starting Computer to the calm message", async () => {
    stub(() => json({ error: { code: "runner_unavailable" } }, 503));
    await expect(
      engineIngestAttachment(ingestDeps, client, actor, { botId: "bot-1", path }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
});
