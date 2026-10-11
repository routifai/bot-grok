// @vitest-environment jsdom

import type { ChatSummary } from "@superchat/contracts";
import type { ReactNode } from "react";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../test/i18n")).withI18nRoot(await orig<typeof import("react-dom/client")>()),
);

import {
  SideChatSession,
  type SideChatView,
  type SideChatWire,
} from "../side-chats/SideChatSession";
import type { FolderEntry } from "./WorkIn";

const BOT = { id: "bot-1", name: "Superchat", color: "#000" };

const view: SideChatView = {
  Transcript: ({ messages }) => <div>{messages.length}</div>,
  Composer: ({ onSend }) => {
    const [value, setValue] = useState("");
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void onSend(value);
        }}
      >
        <textarea value={value} onChange={(event) => setValue(event.target.value)} />
      </form>
    );
  },
};

const dir = (path: string): FolderEntry => ({
  name: path.split("/").pop() ?? path,
  path,
  type: "directory",
});
const file = (path: string): FolderEntry => ({
  name: path.split("/").pop() ?? path,
  path,
  type: "file",
});

/** A workspace with one Project (`projects/q3` has a card), a stray folder under `projects/`,
 * and `reports/2026` to drill into. */
const TREE: Record<string, FolderEntry[]> = {
  "": [dir("projects"), dir("reports"), dir(".cache"), file("notes.md")],
  projects: [dir("projects/q3"), dir("projects/stray")],
  "projects/q3": [file("projects/q3/PROJECT.md")],
  "projects/stray": [],
  reports: [dir("reports/2026")],
  "reports/2026": [],
};

function wire(overrides: Partial<SideChatWire> = {}): SideChatWire {
  return {
    summaryPreview: vi.fn().mockResolvedValue({ summary: "" }),
    createSide: vi.fn(),
    transcript: vi.fn().mockResolvedValue({ threadId: "t", messages: [], olderCursor: null }),
    send: vi.fn(),
    listFolder: vi.fn(async ({ path }: { path: string }) => ({ entries: TREE[path] ?? [] })),
    ...overrides,
  };
}

const roots: Root[] = [];
async function mount(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(node));
  await act(async () => {});
  return host;
}

const settle = () => act(async () => {});
const option = (text: string) =>
  [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find(
    (item) => item.textContent?.trim() === text,
  );
async function choose(text: string) {
  const item = option(text);
  if (!item) throw new Error(`no option "${text}" in ${document.body.textContent}`);
  await act(async () => item.click());
  await settle();
}
async function openPicker(testId: string) {
  const trigger = document.querySelector<HTMLButtonElement>(`[data-testid=${testId}]`);
  await act(async () => trigger?.click());
  await settle();
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => undefined;
  document.body.innerHTML = "";
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
});

it("a new side chat works where the person picks: Projects listed, folders drilled into", async () => {
  const created = { id: "side-1", title: "x" } as ChatSummary;
  const w = wire({ createSide: vi.fn().mockResolvedValue(created) });
  await mount(
    <SideChatSession
      bot={BOT}
      view={view}
      chat="draft"
      wire={w}
      onCreated={() => undefined}
      onClose={() => undefined}
    />,
  );
  const pill = document.querySelector("[data-testid=side-chat-folder]");
  expect(pill?.textContent).toBe("Work in: Whole workspace");

  await openPicker("side-chat-folder");
  // Projects carry a card; hidden folders and files are left out.
  const items = [...document.querySelectorAll("[cmdk-item]")].map((i) => i.textContent?.trim());
  expect(items).toEqual(["Whole workspace", "q3", "reports"]);

  await choose("reports");
  await choose("2026");
  await choose("Work in 2026");
  expect(pill?.textContent).toBe("Work in: 2026");

  const form = document.querySelector("form");
  const textarea = document.querySelector("textarea");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, "what's here?");
    textarea?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(w.createSide).toHaveBeenCalledWith({
    botId: "bot-1",
    start: "withContext",
    text: "what's here?",
    folder: "reports/2026",
  });
});

it("opened from Files, the pill shows that folder, and the whole workspace sends none", async () => {
  const w = wire({ createSide: vi.fn().mockResolvedValue({ id: "s", title: "x" }) });
  await mount(
    <SideChatSession
      bot={BOT}
      view={view}
      chat="draft"
      folder="projects/q3"
      wire={w}
      onCreated={() => undefined}
      onClose={() => undefined}
    />,
  );
  const pill = document.querySelector("[data-testid=side-chat-folder]");
  expect(pill?.textContent).toBe("Work in: q3");
  await openPicker("side-chat-folder");
  expect(option("q3")?.getAttribute("data-checked")).toBe("true");
  await choose("Whole workspace");
  expect(pill?.textContent).toBe("Work in: Whole workspace");
});

it("an existing chat's chip moves it through the engine and then says where it works", async () => {
  const place = { project: null, folder: null as string | null, chosen: false };
  const setFolder = vi.fn(async ({ folder }: { folder: string | null }) => {
    place.folder = folder;
    place.chosen = folder !== null;
  });
  const w = wire({
    project: vi.fn(async () => ({ ...place })),
    setFolder,
  });
  const chat = {
    id: "side-7",
    title: "Budget",
    start: "blank",
    summary: null,
    archived: false,
    live: false,
    updatedAt: "2026-10-03T10:00:00.000Z",
  } satisfies ChatSummary;
  await mount(
    <SideChatSession
      bot={BOT}
      view={view}
      chat={chat}
      wire={w}
      onCreated={() => undefined}
      onClose={() => undefined}
    />,
  );
  const chip = () => document.querySelector("[data-testid=work-in-chip]");
  expect(chip()?.textContent).toBe("Work in…");

  await openPicker("work-in-chip");
  await choose("reports");
  await choose("Work in reports");
  await settle();
  expect(setFolder).toHaveBeenCalledWith({ botId: "bot-1", chatId: "side-7", folder: "reports" });
  expect(chip()?.textContent).toBe("Working in reports");

  await openPicker("work-in-chip");
  await choose("Whole workspace");
  await settle();
  expect(setFolder).toHaveBeenLastCalledWith({ botId: "bot-1", chatId: "side-7", folder: null });
  expect(chip()?.textContent).toBe("Work in…");
});
