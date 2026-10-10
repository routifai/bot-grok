// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../../test/i18n")).withI18nRoot(
    await orig<typeof import("react-dom/client")>(),
  ),
);

const list = vi.fn();
vi.mock("../../../lib/rpc", () => ({ rpc: { artifacts: { list: (a: unknown) => list(a) } } }));
vi.mock("./ArtifactInlinePreview", async () => {
  const { useEffect } = await import("react");
  return {
    ArtifactInlinePreview: ({
      artifactId,
      onText,
    }: {
      artifactId: string;
      onText?: (text: string) => void;
    }) => {
      // The file arrives: a deck of three slides.
      useEffect(() => {
        onText?.('<section class="slide a"></section>'.repeat(3));
      }, [onText]);
      return <div data-preview={artifactId} />;
    },
  };
});
vi.mock("../../../components/cards/catalog", () => ({
  Frame: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  formatSize: () => "1 KB",
  catalog: { file: () => <div data-plain-file /> },
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (p: TemplateStringsArray) => p.join("") }),
}));
vi.mock("@nova/ui-web", () => {
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

function render(data: {
  name: string;
  artifactId?: string;
  kind?: string;
  size?: number;
}): HTMLElement {
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

it("labels a deck as a deck with its slide count, not as an HTML file", () => {
  const host = render({ name: "q3.deck.html", artifactId: "art-1", kind: "html", size: 432_000 });
  expect(host.textContent).toContain("Deck · 3 slides");
  expect(host.textContent).not.toContain("HTML");
  const page = render({ name: "plan.html", artifactId: "art-2", kind: "html", size: 1000 });
  expect(page.textContent).toContain("HTML · 1 KB");
});
