import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getOmnigentWorkingProject,
  projectNameFromCard,
  projectSlugFromWorkspace,
} from "./projects.js";

const CONFIG = { baseUrl: "http://omnigent.test", proxySecret: "proxy-secret" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("projectSlugFromWorkspace", () => {
  it("names the Project a working directory is in, or under", () => {
    const root = "/home/aiden/workspace";
    expect(projectSlugFromWorkspace(`${root}/projects/q3-deck`)).toBe("q3-deck");
    expect(projectSlugFromWorkspace(`${root}/projects/q3-deck/drafts`)).toBe("q3-deck");
  });

  it("is null at the workspace root, elsewhere and when unknown", () => {
    expect(projectSlugFromWorkspace("/home/aiden/workspace")).toBeNull();
    expect(projectSlugFromWorkspace("/home/aiden/workspace/projects")).toBeNull();
    expect(projectSlugFromWorkspace("/home/aiden/workspace/goals/x")).toBeNull();
    expect(projectSlugFromWorkspace("/home/aiden/workspace/projects/Bad Name")).toBeNull();
    expect(projectSlugFromWorkspace(null)).toBeNull();
    expect(projectSlugFromWorkspace(undefined)).toBeNull();
  });
});

describe("projectNameFromCard", () => {
  it("reads the name from the front matter", () => {
    expect(projectNameFromCard("---\nname: Q3 board deck\nsummary: x\n---\nNotes")).toBe(
      "Q3 board deck",
    );
    expect(projectNameFromCard('---\nname: "Dana\'s report"\n---\n')).toBe("Dana's report");
  });

  it("is null without usable front matter", () => {
    expect(projectNameFromCard("name: nope")).toBeNull();
    expect(projectNameFromCard("---\nsummary: no name\n---\n")).toBeNull();
    expect(projectNameFromCard("---\nname:   \n---\n")).toBeNull();
  });
});

describe("getOmnigentWorkingProject", () => {
  const stub = (workspace: string | null, card: Response | Error) => {
    const fetchMock = vi.fn(async (url: URL) => {
      if (url.pathname.endsWith("/filesystem/projects/q3-deck/PROJECT.md")) {
        if (card instanceof Error) throw card;
        return card;
      }
      return json({ id: "conv_1", workspace });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };
  const cardResponse = (text: string) =>
    json({
      object: "session.environment.filesystem.file_content",
      path: "projects/q3-deck/PROJECT.md",
      encoding: "utf-8",
      content: text,
      bytes: text.length,
    });

  it("maps an open Project to its card's name", async () => {
    stub("/home/aiden/workspace/projects/q3-deck", cardResponse("---\nname: Q3 board deck\n---\n"));
    await expect(getOmnigentWorkingProject(CONFIG, "a@b.c", "conv_1")).resolves.toEqual({
      slug: "q3-deck",
      name: "Q3 board deck",
    });
  });

  it("falls back to the slug when the card cannot be read", async () => {
    stub("/home/aiden/workspace/projects/q3-deck", json({ error: "gone" }, 404));
    await expect(getOmnigentWorkingProject(CONFIG, "a@b.c", "conv_1")).resolves.toEqual({
      slug: "q3-deck",
      name: "q3-deck",
    });
  });

  it("is null at the workspace root and reads no card", async () => {
    const fetchMock = stub("/home/aiden/workspace", cardResponse(""));
    await expect(getOmnigentWorkingProject(CONFIG, "a@b.c", "conv_1")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
