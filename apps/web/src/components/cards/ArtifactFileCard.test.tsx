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

const hosts: HTMLElement[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
  list.mockReset();
});

function render(data: { name: string; artifactId?: string }): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  hosts.push(host);
  act(() => createRoot(host).render(<ArtifactFileCard data={data} />));
  return host;
}

it("previews a card by its artifact id without listing deliverables", () => {
  const host = render({ name: "plan.html", artifactId: "art-9" });
  expect(host.querySelector("[data-preview]")?.getAttribute("data-preview")).toBe("art-9");
  expect(list).not.toHaveBeenCalled();
});

it("keeps the plain card, with no lookup, when the card has no artifact id", () => {
  const host = render({ name: "none.html" });
  expect(host.querySelector("[data-plain-file]")).not.toBeNull();
  expect(list).not.toHaveBeenCalled();
});
