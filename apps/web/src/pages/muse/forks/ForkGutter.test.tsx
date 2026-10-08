// @vitest-environment jsdom

import type { MessageFork, ThreadMessage } from "@aiden/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../../test/i18n")).withI18nRoot(
    await orig<typeof import("react-dom/client")>(),
  ),
);

const { template } = vi.hoisted(() => ({
  template: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((acc, part, i) => `${acc}${part}${values[i] ?? ""}`, ""),
}));
vi.mock("@lingui/core/macro", () => ({
  t: template,
  plural: (count: number, forms: { one: string; other: string }) =>
    (count === 1 ? forms.one : forms.other).replace("#", String(count)),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: template, i18n: { locale: "en" } }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { ForkGutter } from "./ForkGutter";
import type { ForkRow } from "./forkModel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeObserver {
  observe() {}
  disconnect() {}
}

const fork = (chatId: string, overrides: Partial<MessageFork> = {}): MessageFork => ({
  chatId,
  title: `Fork ${chatId}`,
  replies: 1,
  live: false,
  unread: false,
  state: "open",
  summary: null,
  createdAt: "2026-10-07T09:31:00.000Z",
  ...overrides,
});

const message = (id: string, forks?: MessageFork[]) =>
  ({
    id,
    threadId: "t",
    seq: 1,
    role: "bot",
    blocks: [{ kind: "text", text: id }],
    forks,
  }) as unknown as ThreadMessage;

/** A scroller whose rows sit at the given tops (px), 40px tall, in a 1000px-tall scroll. */
function scroller(tops: Record<string, number>) {
  const el = document.createElement("div");
  for (const id of Object.keys(tops)) {
    const row = document.createElement("div");
    row.dataset.messageId = id;
    row.getBoundingClientRect = () => ({ top: tops[id], height: 40 }) as DOMRect;
    el.append(row);
  }
  el.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  Object.defineProperty(el, "scrollHeight", { value: 1000 });
  Object.defineProperty(el, "clientHeight", { value: 600 });
  el.scrollTo = vi.fn() as unknown as typeof el.scrollTo;
  document.body.append(el);
  return el;
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeObserver);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const rowFor = (anchorItemId: string, status: ForkRow["status"] = "open") =>
  ({ anchorItemId, status }) as ForkRow;

function mount(
  props: Partial<Parameters<typeof ForkGutter>[0]> & { tops: Record<string, number> },
  messages: ThreadMessage[],
) {
  const el = scroller(props.tops);
  const onJump = vi.fn();
  act(() => {
    root.render(
      <ForkGutter
        scrollRef={{ current: el }}
        messages={messages}
        forks={props.forks ?? []}
        onJump={onJump}
        onLoadEarlier={props.onLoadEarlier}
      />,
    );
  });
  return { el, onJump };
}

it("draws a lone open fork as a dot and a lone finished one as a tick, jumping on click", () => {
  const { onJump } = mount({ tops: { m1: 100, m2: 400 } }, [
    message("m1", [fork("a")]),
    message("m2", [fork("b", { state: "added" })]),
  ]);
  const buttons = container.querySelectorAll<HTMLButtonElement>("button");
  expect(buttons).toHaveLength(2);
  expect(buttons[0]?.getAttribute("aria-label")).toBe("Fork a");
  expect(buttons[0]?.querySelector(".rounded-full.size-3")).not.toBeNull();
  expect(buttons[1]?.querySelector(".h-\\[3px\\]")).not.toBeNull();
  expect(container.querySelector(".border-dashed")).toBeNull();
  act(() => buttons[0]?.click());
  expect(onJump).toHaveBeenCalledWith("m1");
});

it("merges close marks into a count capsule whose popover lists the forks and jumps", () => {
  const { onJump } = mount({ tops: { m1: 100, m2: 110 } }, [
    message("m1", [fork("a")]),
    message("m2", [fork("b", { live: true }), fork("c", { state: "added" })]),
  ]);
  const capsule = container.querySelector<HTMLButtonElement>('button[aria-label="3 forks"]');
  expect(capsule?.textContent).toBe("3");
  act(() => capsule?.click());
  const popup = document.body.querySelector('[data-slot="popover-content"]');
  expect(popup?.textContent).toContain("Fork a");
  expect(popup?.textContent).toContain("Open");
  expect(popup?.textContent).toContain("Nova is working");
  expect(popup?.textContent).toContain("Finished");
  const item = [...(popup?.querySelectorAll("button") ?? [])].find((b) =>
    b.textContent?.includes("Fork b"),
  );
  act(() => item?.click());
  expect(onJump).toHaveBeenCalledWith("m2");
  expect(document.body.querySelector('[data-slot="popover-content"]')).toBeNull();
});

it("shows ↑ N for forks anchored in unloaded history, loads earlier on click, hides at 0", async () => {
  const onLoadEarlier = vi.fn(async () => undefined);
  const forks = [rowFor("old-1"), rowFor("old-2", "added"), rowFor("old-3", "archived")];
  const { el } = mount({ tops: { m1: 100 }, forks, onLoadEarlier }, [message("m1", [fork("a")])]);
  const more = container.querySelector<HTMLButtonElement>('[data-testid="fork-gutter-more"]');
  expect(more?.textContent).toBe("↑ 2");
  await act(async () => more?.click());
  expect(onLoadEarlier).toHaveBeenCalled();
  expect(el.scrollTo).toHaveBeenCalledWith({ top: 0 });

  act(() => {
    root.render(
      <ForkGutter
        scrollRef={{ current: el }}
        messages={[message("m1", [fork("a")]), message("old-1"), message("old-2")]}
        forks={forks}
        onJump={() => {}}
      />,
    );
  });
  expect(container.querySelector('[data-testid="fork-gutter-more"]')).toBeNull();
});

it("renders nothing when no fork is on the rail", () => {
  mount({ tops: { m1: 100 } }, [message("m1")]);
  expect(container.querySelector('[data-testid="fork-gutter"]')).toBeNull();
});
