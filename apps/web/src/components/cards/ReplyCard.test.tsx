// @vitest-environment jsdom

import type { ReplyCardBlock } from "@aiden/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((acc, part, i) => `${acc}${part}${values[i] ?? ""}`, "");
  return { useLingui: () => ({ t, i18n: { locale: "en" } }) };
});
vi.mock("@aiden/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children?: ReactNode }) => <div data-md>{children}</div>,
}));
vi.mock("@aiden/ui-web", () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
    Badge: Passthrough,
    Card: ({ children }: { children?: ReactNode }) => (
      <div data-testid="reply-card">{children}</div>
    ),
    CardAction: Passthrough,
    CardContent: Passthrough,
    CardHeader: Passthrough,
    CardTitle: Passthrough,
    CanvasChart: () => <div data-chart />,
    Checkbox: () => <input type="checkbox" readOnly />,
    Skeleton: () => <i data-skeleton />,
    Button: ({ render, ...props }: ComponentProps<"button"> & { render?: ReactNode }) =>
      render ? <a {...(props as object)} /> : <button type="button" {...props} />,
  };
});

import { ReplyCardSendProvider } from "./context";
import { ReplyCard } from "./ReplyCard";

const mounted: HTMLElement[] = [];
function mount(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  mounted.push(host);
  act(() => createRoot(host).render(node));
  return host;
}
afterEach(() => {
  for (const host of mounted.splice(0)) host.remove();
});

const block = (over: Partial<ReplyCardBlock>): ReplyCardBlock => ({
  kind: "reply_card",
  card: "sources",
  data: {},
  fallback: "**Fallback** text",
  ...over,
});

it("draws the fallback markdown for an unknown kind or malformed data", () => {
  const unknown = mount(<ReplyCard block={block({ card: "hologram" })} />);
  expect(unknown.querySelector("[data-md]")?.textContent).toBe("**Fallback** text");
  const malformed = mount(<ReplyCard block={block({ card: "quote", data: { symbol: "A" } })} />);
  expect(malformed.querySelector("[data-md]")).not.toBeNull();
  expect(malformed.querySelector("[data-testid=reply-card]")).toBeNull();
});

it("shows a skeleton while pending", () => {
  const host = mount(<ReplyCard block={block({ pending: true })} />);
  expect(host.querySelector("[data-skeleton]")).not.toBeNull();
});

it("links only http(s) and always with noopener noreferrer", () => {
  const host = mount(
    <ReplyCard
      block={block({
        data: {
          items: [
            { title: "Good", url: "https://example.com/a" },
            { title: "Bad", url: "javascript:alert(1)" },
          ],
        },
      })}
    />,
  );
  const links = [...host.querySelectorAll("a")];
  expect(links).toHaveLength(1);
  expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
  expect(host.textContent).toContain("Bad");
});

const ask = block({
  card: "ask",
  data: {
    question: "Which?",
    options: [
      { id: "a", label: "Berlin" },
      { id: "b", label: "Seoul" },
    ],
  },
});

it("sends the option label and locks the card", () => {
  const send = vi.fn();
  const host = mount(
    <ReplyCardSendProvider send={send}>
      <ReplyCard block={ask} />
    </ReplyCardSendProvider>,
  );
  const buttons = () => [...host.querySelectorAll("button")];
  act(() => buttons()[1]?.click());
  expect(send).toHaveBeenCalledWith("Seoul");
  expect(buttons()[0]?.disabled).toBe(true);
  act(() => buttons()[1]?.click());
  expect(send).toHaveBeenCalledTimes(1);
});

it("shows an already answered ask locked on the chosen option", () => {
  const send = vi.fn();
  const host = mount(
    <ReplyCardSendProvider send={send}>
      <ReplyCard block={ask} answer="Berlin" />
    </ReplyCardSendProvider>,
  );
  const [berlin, seoul] = [...host.querySelectorAll("button")];
  expect(berlin?.getAttribute("aria-pressed")).toBe("true");
  expect(seoul?.disabled).toBe(true);
});
