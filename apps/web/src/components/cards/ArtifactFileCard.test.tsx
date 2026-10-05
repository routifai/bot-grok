// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const list = vi.fn();
vi.mock("../../lib/rpc", () => ({ rpc: { artifacts: { list: (a: unknown) => list(a) } } }));
vi.mock("./ArtifactInlinePreview", () => ({
  ArtifactInlinePreview: ({ artifactId }: { artifactId: string }) => (
    <div data-preview={artifactId} />
  ),
}));
vi.mock("./catalog", () => ({
  Frame: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  formatSize: () => "1 KB",
  catalog: { file: () => <div data-plain-file /> },
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (p: TemplateStringsArray) => p.join("") }),
}));
vi.mock("@aiden/ui-web", () => {
  const P = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: P,
    DropdownMenu: P,
    DropdownMenuContent: P,
    DropdownMenuItem: P,
    DropdownMenuTrigger: P,
  };
});

import { ArtifactFileCard } from "./ArtifactFileCard";
import { ReplyCardBotProvider } from "./context";

const hosts: HTMLElement[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
  list.mockReset();
});

it("matches a hand-written file card to the Muse's deliverable by name", async () => {
  list.mockResolvedValue([{ id: "art-9", name: "plan.html", size: 10, version: 1 }]);
  const host = document.createElement("div");
  document.body.append(host);
  hosts.push(host);
  await act(async () =>
    createRoot(host).render(
      <ReplyCardBotProvider botId="bot-1">
        <ArtifactFileCard data={{ name: "plan.html", kind: "html" }} />
      </ReplyCardBotProvider>,
    ),
  );
  await vi.waitFor(() =>
    expect(host.querySelector("[data-preview]")?.getAttribute("data-preview")).toBe("art-9"),
  );
  expect(list).toHaveBeenCalledWith({ botId: "bot-1" });
});

it("keeps the plain card when no deliverable has that name", async () => {
  list.mockResolvedValue([]);
  const host = document.createElement("div");
  document.body.append(host);
  hosts.push(host);
  await act(async () =>
    createRoot(host).render(
      <ReplyCardBotProvider botId="bot-1">
        <ArtifactFileCard data={{ name: "none.html" }} />
      </ReplyCardBotProvider>,
    ),
  );
  expect(host.querySelector("[data-plain-file]")).not.toBeNull();
});
