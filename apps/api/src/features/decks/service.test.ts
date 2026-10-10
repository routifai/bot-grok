import type { PrismaClient } from "@nova/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  engineDeckTheme,
  engineDeckThemeSample,
  engineDeckThemes,
  engineEditDeck,
  engineExportDeck,
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

describe("engine deck edit", () => {
  const patches = [{ kind: "set-text" as const, id: "title", text: "B" }];
  it("patches and returns the new manual version", async () => {
    const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => {
      expect(url.pathname).toBe("/v1/artifacts/a1/edit");
      expect(init?.method).toBe("PATCH");
      return json({ ...row, id: "a3", version: 2 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const created = await engineEditDeck(deps, client, actor, {
      artifactId: "a1",
      baseVersion: 1,
      patches,
    });
    expect(created).toMatchObject({ id: "a3" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      base_version: 1,
      patches,
    });
  });

  it("maps a 409 to CONFLICT with the engine's words", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(
          {
            error: { code: "conflict", message: "Can't apply that edit exactly: ask Nova instead" },
          },
          409,
        ),
      ),
    );
    await expect(
      engineEditDeck(deps, client, actor, { artifactId: "a1", baseVersion: 1, patches }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("ask Nova") });
  });
});

describe("engine deck themes", () => {
  it("lists the dictionary in the web's shape", async () => {
    const fetchMock = vi.fn(async (url: URL) => {
      expect(url.pathname).toBe("/v1/decks/themes");
      return json({
        default: "corporate-clean",
        themes: [
          {
            id: "corporate-clean",
            name: "Corporate Clean",
            tagline: "Sober, board-ready",
            mood: "White and navy.",
            category: "professional",
            mode: "light",
            best_for: "board reports",
            preview: "data:image/webp;base64,AA==",
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await engineDeckThemes(deps, client, actor)).toEqual({
      defaultTheme: "corporate-clean",
      themes: [
        {
          id: "corporate-clean",
          name: "Corporate Clean",
          tagline: "Sober, board-ready",
          mood: "White and navy.",
          category: "professional",
          mode: "light",
          bestFor: "board reports",
          preview: "data:image/webp;base64,AA==",
        },
      ],
    });
  });

  it("sends a set-theme patch as an ordinary edit", async () => {
    const patches = [{ kind: "set-theme" as const, theme: "nord" }];
    const fetchMock = vi.fn(async () => json({ ...row, id: "a3", version: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    await engineEditDeck(deps, client, actor, { artifactId: "a1", baseVersion: 1, patches });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).patches).toEqual(patches);
  });
});

describe("engine deck theme sample", () => {
  it("returns the theme's sample deck html", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        expect(url.pathname).toBe("/v1/decks/themes/nord/sample");
        return json({ html: "<!doctype html><title>Quarterly review</title>" });
      }),
    );
    expect(await engineDeckThemeSample(deps, client, actor, { themeId: "nord" })).toEqual({
      html: "<!doctype html><title>Quarterly review</title>",
    });
  });

  it("maps an unknown theme to NOT_FOUND", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: { code: "not_found", message: "Unknown theme" } }, 404)),
    );
    await expect(
      engineDeckThemeSample(deps, client, actor, { themeId: "nope" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("engine deck theme", () => {
  it("reads the theme id, or null for a hand-made deck", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        expect(url.pathname).toBe("/v1/decks/a1/theme");
        return json({ theme: "nord" });
      }),
    );
    expect(await engineDeckTheme(deps, client, actor, { artifactId: "a1" })).toEqual({
      theme: "nord",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ theme: null })),
    );
    expect(await engineDeckTheme(deps, client, actor, { artifactId: "a1" })).toEqual({
      theme: null,
    });
  });
});
