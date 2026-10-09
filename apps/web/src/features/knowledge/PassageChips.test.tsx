// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../test/i18n")).withI18nRoot(await orig<typeof import("react-dom/client")>()),
);
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((acc, part, i) => `${acc}${part}${values[i] ?? ""}`, "");
  return { useLingui: () => ({ t }) };
});
const pageThumbnail = vi.fn();
vi.mock("../../lib/rpc", () => ({
  rpc: { knowledge: { pageThumbnail: (...a: unknown[]) => pageThumbnail(...a) } },
}));

import { ArtifactPanelProvider } from "../../components/cards/context";
import { PassageChips, resetThumbnailCache } from "./PassageChips";

const A = "a".repeat(32);
const B = "b".repeat(32);
const data = {
  items: [
    { artifactId: A, name: "finance.pdf", page: 2, hasThumbnail: true },
    { artifactId: B, name: "notes.md", page: 1 },
  ],
};

const hosts: HTMLElement[] = [];
async function mount(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  hosts.push(host);
  await act(async () => createRoot(host).render(node));
  return host;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  pageThumbnail
    .mockReset()
    .mockResolvedValue({ contentBase64: "UklGRg==", mimeType: "image/webp" });
});
afterEach(() => {
  resetThumbnailCache();
  for (const host of hosts.splice(0)) host.remove();
});

it("draws a thumbnail chip per page, fetching each thumbnail once", async () => {
  const host = await mount(<PassageChips data={data} />);
  const chips = host.querySelectorAll("button");
  expect(chips).toHaveLength(2);
  expect(chips[0]?.textContent).toContain("finance.pdf");
  expect(chips[0]?.textContent).toContain("p. 2");
  expect(chips[0]?.getAttribute("aria-label")).toBe("Open finance.pdf, page 2");
  expect(pageThumbnail).toHaveBeenCalledTimes(1);
  expect(pageThumbnail).toHaveBeenCalledWith({ artifactId: A, page: 2 });
  expect(chips[0]?.querySelector("img")?.getAttribute("src")).toBe(
    "data:image/webp;base64,UklGRg==",
  );
  // A file without page images gets an icon, not a request.
  expect(chips[1]?.querySelector("img")).toBeNull();
  expect(chips[1]?.querySelector("svg")).not.toBeNull();
});

it("clicking a chip opens the file at that page in the panel", async () => {
  const open = vi.fn();
  const host = await mount(
    <ArtifactPanelProvider value={{ openId: null, open, close: vi.fn() }}>
      <PassageChips data={data} />
    </ArtifactPanelProvider>,
  );
  await act(async () => host.querySelectorAll("button")[0]?.click());
  expect(open).toHaveBeenCalledWith(A, "finance.pdf", 2);
  await act(async () => host.querySelectorAll("button")[1]?.click());
  expect(open).toHaveBeenLastCalledWith(B, "notes.md", 1);
});

it("chips are inert where no panel exists", async () => {
  const host = await mount(<PassageChips data={data} />);
  expect(host.querySelector("button")?.disabled).toBe(true);
});

it("keeps the placeholder when a thumbnail cannot be fetched", async () => {
  pageThumbnail.mockRejectedValue(new Error("gone"));
  const host = await mount(<PassageChips data={data} />);
  expect(host.querySelector("img")).toBeNull();
  expect(host.querySelectorAll("button")).toHaveLength(2);
});
