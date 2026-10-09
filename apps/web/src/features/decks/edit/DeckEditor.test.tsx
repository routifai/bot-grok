// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { DeckEditTarget } from "@nova/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...v: unknown[]) =>
      parts.reduce((out, part, i) => out + part + (v[i] ?? ""), ""),
  }),
}));

import {
  clearComposerAttachments,
  useComposerAttachments,
  useComposerAttachTarget,
} from "../../../lib/composer-attachments";
import { DeckViewer } from "../DeckViewer";
import { FIXTURE_DECK } from "../deck-fixture";
import { resetDeckUi, setDeckEditing } from "../deck-ui-state";
import { COMMIT_DEBOUNCE_MS } from "./committer";

i18n.loadAndActivate({ locale: "en", messages: {} });

const NAME = "launch.deck.html";
const THEME = {
  colors: [
    { name: "--accent", value: "#1e2bfa" },
    { name: "--fg", value: "#111111" },
  ],
  fonts: [{ name: "--font-display", value: '"Space Grotesk", sans-serif', label: "Space Grotesk" }],
  slideCount: 3,
};

const title: DeckEditTarget = {
  id: "title",
  kind: "text",
  tag: "h1",
  slide: 1,
  text: "Launch",
  editable: true,
  rect: { x: 100, y: 120, w: 800, h: 90 },
  inline: {},
  computed: {
    "font-family": '"Inter", sans-serif',
    "font-size": "64px",
    "font-weight": "700",
    "font-style": "normal",
    color: "rgb(17, 17, 17)",
    "text-align": "left",
    "line-height": "76.8px",
    "letter-spacing": "0px",
    "background-color": "rgba(0, 0, 0, 0)",
    "border-radius": "0px",
    "padding-top": "0px",
    opacity: "1",
  },
  href: null,
  alt: null,
};

let root: Root;
let host: HTMLElement;
const edits: Array<{ artifactId: string; baseVersion: number; patches: unknown[] }> = [];

function AttachProbe({ out }: { out: { current: ReturnType<typeof useComposerAttachments> } }) {
  useComposerAttachTarget();
  out.current = useComposerAttachments();
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  edits.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  resetDeckUi();
  clearComposerAttachments();
  document.body.innerHTML = "";
});

const source = async (input: { artifactId: string; baseVersion: number; patches: unknown[] }) => {
  edits.push(input);
  return { id: `v${input.baseVersion + 1}`, version: input.baseVersion + 1 };
};

type Probe = { current: ReturnType<typeof useComposerAttachments> };

async function mount(opts: { version?: number; html?: string; probe?: Probe } = {}) {
  const view = (version: number, html: string) => (
    <I18nProvider i18n={i18n}>
      {opts.probe ? <AttachProbe out={opts.probe} /> : null}
      <DeckViewer
        html={html}
        title={NAME}
        artifact={{ id: `v${version}`, version }}
        editSource={source}
      />
    </I18nProvider>
  );
  await act(async () => root.render(view(opts.version ?? 1, opts.html ?? FIXTURE_DECK)));
  return {
    rerender: (version: number, html: string) => act(async () => root.render(view(version, html))),
  };
}

/** The visible edit frame, its bridge nonce and the messages the host posts into it. */
function editFrame() {
  const el = host.querySelector('[data-testid="deck-edit-frame"] iframe') as HTMLIFrameElement;
  const nonce = /NONCE = \\"([0-9a-f]{32})\\"/.exec(el.getAttribute("srcdoc") ?? "")?.[1] ?? "";
  const post = vi.fn();
  Object.defineProperty(el, "contentWindow", { value: { postMessage: post }, configurable: true });
  return { el, nonce, post };
}

async function fromFrame(frame: ReturnType<typeof editFrame>, msg: Record<string, unknown>) {
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { v: 1, nonce: frame.nonce, ...msg },
        source: frame.el.contentWindow as Window,
      }),
    );
  });
}

const select = (frame: ReturnType<typeof editFrame>, targets: DeckEditTarget[] = [title]) =>
  fromFrame(frame, { type: "nova:edit-selection", targets });
const ready = (frame: ReturnType<typeof editFrame>) =>
  fromFrame(frame, { type: "nova:edit-ready", theme: THEME });

function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
const control = (label: string) =>
  host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement & HTMLButtonElement;

it("shows the bridge and panel only in edit mode; view mode is unchanged", async () => {
  await mount();
  expect(host.querySelector('[data-testid="deck-style-panel"]')).toBeNull();
  const frames = host.querySelectorAll("iframe");
  expect(frames[frames.length - 1]?.getAttribute("srcdoc")).not.toContain("nova-edit-bridge");

  await act(async () => setDeckEditing(NAME, true));
  // The inspector is there only while something is selected.
  expect(host.querySelector('[data-testid="deck-style-panel"]')).toBeNull();
  expect(host.querySelector('[data-testid="deck-edit-toolbar"]')).not.toBeNull();
  expect(editFrame().el.getAttribute("srcdoc")).toContain("nova-edit-bridge");
  const frame = editFrame();
  await ready(frame);
  await select(frame);
  expect(host.querySelector('[data-testid="deck-style-panel"]')).not.toBeNull();
  await fromFrame(frame, { type: "nova:edit-selection", targets: [] });
  expect(host.querySelector('[data-testid="deck-style-panel"]')).toBeNull();

  await act(async () => setDeckEditing(NAME, false));
  expect(host.querySelector('[data-testid="deck-style-panel"]')).toBeNull();
});

it("only trusts messages from its frame that carry its nonce and fit the protocol", async () => {
  await mount();
  await act(async () => setDeckEditing(NAME, true));
  const frame = editFrame();
  await ready(frame);
  const panel = () => host.querySelector('[data-testid="deck-style-panel"]')?.textContent ?? "";

  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { v: 1, nonce: frame.nonce, type: "nova:edit-selection", targets: [title] },
        source: {} as Window,
      }),
    );
  });
  expect(panel()).not.toContain("Heading");
  await fromFrame(frame, { type: "nova:edit-selection", nonce: "f".repeat(32), targets: [title] });
  await fromFrame(frame, { type: "nova:edit-selection", v: 2, targets: [title] });
  await fromFrame(frame, { type: "nova:edit-selection", targets: [{ id: 3 }] });
  expect(panel()).not.toContain("Heading");

  await select(frame);
  expect(panel()).toContain("Slide 1 · Heading");
});

it("select, then a style control previews at once and saves one version after a pause", async () => {
  await mount();
  await act(async () => setDeckEditing(NAME, true));
  const frame = editFrame();
  await ready(frame);
  await select(frame);

  await act(async () => typeInto(control("Font size"), "7"));
  await act(async () => typeInto(control("Font size"), "72"));
  expect(frame.post).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "nova:edit-preview",
      id: "title",
      style: { "font-size": "72px" },
      nonce: frame.nonce,
    }),
    "*",
  );
  expect(edits).toHaveLength(0); // typing does not save a version per keystroke
  await act(async () => {
    await vi.advanceTimersByTimeAsync(COMMIT_DEBOUNCE_MS + 10);
  });
  expect(edits).toEqual([
    {
      artifactId: "v1",
      baseVersion: 1,
      patches: [
        {
          kind: "set-style",
          id: "title",
          style: { "font-size": "72px" },
          before: { "font-size": "64px" },
        },
      ],
    },
  ]);
});

it("picks theme colours and fonts as tokens, never raw values", async () => {
  await mount();
  await act(async () => setDeckEditing(NAME, true));
  const frame = editFrame();
  await ready(frame);
  await select(frame);
  await act(async () => control("accent").click());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(edits[0]?.patches).toEqual([
    {
      kind: "set-style",
      id: "title",
      style: { color: "var(--accent)" },
      before: { color: "rgb(17, 17, 17)" },
    },
  ]);
});

it("commits an inline text edit as a set-text patch", async () => {
  await mount();
  await act(async () => setDeckEditing(NAME, true));
  const frame = editFrame();
  await ready(frame);
  await select(frame);
  await fromFrame(frame, {
    type: "nova:edit-text-commit",
    id: "title",
    text: "Launch day",
    before: "Launch",
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(edits[0]?.patches).toEqual([{ kind: "set-text", id: "title", text: "Launch day" }]);
});

it("undo and redo save the earlier source back as new versions", async () => {
  const view = await mount();
  await act(async () => setDeckEditing(NAME, true));
  const frame = editFrame();
  await ready(frame);
  await select(frame);
  await fromFrame(frame, { type: "nova:edit-text-commit", id: "title", text: "B", before: "A" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  const edited = FIXTURE_DECK.replace("Launch", "B");
  await view.rerender(2, edited); // the saved version arrives

  const undoButton = () => control("Undo");
  expect(undoButton().disabled).toBe(false);
  await act(async () => undoButton().click());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(edits[1]).toEqual({
    artifactId: "v2",
    baseVersion: 2,
    patches: [{ kind: "set-full-source", source: FIXTURE_DECK }],
  });
  await view.rerender(3, FIXTURE_DECK);
  expect(control("Redo").disabled).toBe(false);
  await act(async () => control("Redo").click());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(edits[2]?.patches).toEqual([{ kind: "set-full-source", source: edited }]);
});

it("a change by someone else ends the history instead of undoing over it", async () => {
  const view = await mount();
  await act(async () => setDeckEditing(NAME, true));
  const frame = editFrame();
  await ready(frame);
  await select(frame);
  await fromFrame(frame, { type: "nova:edit-text-commit", id: "title", text: "B", before: "A" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  await view.rerender(2, FIXTURE_DECK.replace("Launch", "B"));
  expect(control("Undo").disabled).toBe(false);
  await view.rerender(3, FIXTURE_DECK.replace("Launch", "C")); // Nova saved a version
  expect(control("Undo").disabled).toBe(true);
});

it("a patch the engine won't apply exactly says so and offers Nova", async () => {
  const refuse = async () => {
    throw Object.assign(new Error("Can't apply that edit exactly; ask Nova instead"), {
      code: "CONFLICT",
    });
  };
  const probe: Probe = { current: [] };
  await act(async () =>
    root.render(
      <I18nProvider i18n={i18n}>
        <AttachProbe out={probe} />
        <DeckViewer
          html={FIXTURE_DECK}
          title={NAME}
          artifact={{ id: "v1", version: 1 }}
          editSource={refuse}
        />
      </I18nProvider>,
    ),
  );
  await act(async () => setDeckEditing(NAME, true));
  const frame = editFrame();
  await ready(frame);
  await select(frame);
  await fromFrame(frame, { type: "nova:edit-text-commit", id: "title", text: "B", before: "A" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  const notice = host.querySelector('[data-testid="deck-edit-notice"]');
  expect(notice?.textContent).toContain("can't be made exactly by hand");
  const ask = [...(notice?.querySelectorAll("button") ?? [])].find((b) =>
    b.textContent?.includes("Ask Nova instead"),
  );
  await act(async () => ask?.click());
  expect(probe.current[0]?.block).toContain('<element id="title"');
});

it("Ask Nova attaches a hard-scope element request with the person's note", async () => {
  const probe: Probe = { current: [] };
  await mount({ probe });
  await act(async () => setDeckEditing(NAME, true));
  const frame = editFrame();
  await ready(frame);
  await select(frame);
  await act(async () => typeInto(control("What should change?"), "make it punchier"));
  const ask = [...host.querySelectorAll("button")].find((b) => b.textContent === "Ask Nova");
  await act(async () => ask?.click());
  const attachment = probe.current[0];
  expect(attachment?.kind).toBe("deck");
  expect(attachment?.label).toBe("Slide 1 · title");
  expect(attachment?.block).toContain(
    '<nova-element-request deck="launch.deck.html" artifact="v1"',
  );
  expect(attachment?.block).toContain("Hard scope: change ONLY these elements");
  expect(attachment?.block).toContain('text: "Launch"');
  expect(attachment?.block).toContain("request: make it punchier");
});

it("the Ask Nova button on the selection (a bridge message) attaches too", async () => {
  const probe: Probe = { current: [] };
  await mount({ probe });
  await act(async () => setDeckEditing(NAME, true));
  const frame = editFrame();
  await ready(frame);
  await select(frame);
  await fromFrame(frame, { type: "nova:edit-ask" });
  expect(probe.current[0]?.block).toContain('<element id="title"');
});

it("a new version keeps the selection by selecting the same ids in the new frame", async () => {
  const view = await mount();
  await act(async () => setDeckEditing(NAME, true));
  const frame = editFrame();
  await ready(frame);
  await select(frame);
  await view.rerender(2, FIXTURE_DECK.replace("Launch", "B"));
  const next = host.querySelector(
    '[data-testid="deck-edit-frame-next"] iframe',
  ) as HTMLIFrameElement;
  expect(next).not.toBeNull(); // loads hidden; the old frame stays until the new one is ready
  const nextFrame = {
    el: next,
    nonce: /NONCE = \\"([0-9a-f]{32})\\"/.exec(next.getAttribute("srcdoc") ?? "")?.[1] ?? "",
    post: vi.fn(),
  };
  Object.defineProperty(next, "contentWindow", {
    value: { postMessage: nextFrame.post },
    configurable: true,
  });
  await ready(nextFrame);
  expect(nextFrame.post).toHaveBeenCalledWith(
    expect.objectContaining({ type: "nova:edit-select", ids: ["title"] }),
    "*",
  );
  expect(host.querySelector('[data-testid="deck-edit-frame-next"]')).toBeNull();
});
