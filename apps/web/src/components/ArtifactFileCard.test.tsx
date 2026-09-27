// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ getById: vi.fn() }));
vi.mock("../lib/rpc", () => ({ rpc: { artifacts: api } }));
vi.mock("../lib/artifact-open", () => ({
  decodeArtifactBase64: (base64: string) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  },
  downloadArtifact: vi.fn(),
  downloadArtifactBytes: vi.fn(),
  fetchArtifactBytes: vi.fn(),
}));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ""}`, ""),
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ""}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@aiden/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@aiden/ui-web", () => {
  const Passthrough = ({ children, ...props }: ComponentProps<"div">) => (
    <div {...props}>{children}</div>
  );
  return {
    Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
    Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
      open ? <div>{children}</div> : null,
    DialogClose: Passthrough,
    DialogContent: Passthrough,
    DialogTitle: Passthrough,
  };
});

import { ArtifactFileCard } from "./ArtifactFileCard";

/** Immediately reports every observed element as intersecting, so the lazy
 *  thumbnail fetch in `ArtifactPreviewThumbnail` runs synchronously in tests. */
class ImmediateIntersectionObserver {
  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element) {
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

async function renderCard(props: ComponentProps<typeof ArtifactFileCard>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ArtifactFileCard {...props} />);
  });
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const html = "<h1>Ukrainian Hello</h1>";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", ImmediateIntersectionObserver);
  api.getById.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("shows the same live preview as the Library for a freshly attached HTML artifact", async () => {
  api.getById.mockResolvedValue({
    id: "artifact-1",
    contentBase64: btoa(html),
    mimeType: "text/html",
  });

  const view = await renderCard({
    target: { botId: "bot-1" },
    artifactId: "artifact-1",
    name: "Ukrainian Hello",
    mimeType: "text/html",
    size: 2500,
    museMode: true,
  });
  try {
    await act(async () => {
      await vi.waitFor(() => {
        expect(view.container.querySelector("iframe")).toBeTruthy();
      });
    });
    // The preview is resolved from the block's artifactId alone (getById), the same
    // way the Library's own thumbnail does — not from anything precomputed elsewhere.
    expect(api.getById).toHaveBeenCalledWith({ artifactId: "artifact-1" });
    const iframe = view.container.querySelector("iframe");
    expect(iframe?.getAttribute("srcdoc")).toContain("Ukrainian Hello");
    expect(view.container.textContent).toContain("Ukrainian Hello");
    expect(view.container.textContent).toContain("PAGE");
  } finally {
    await view.cleanup();
  }
});

it("keeps the plain row outside muse mode, without eagerly fetching a preview", async () => {
  const view = await renderCard({
    target: { botId: "bot-1" },
    artifactId: "artifact-2",
    name: "Ukrainian Hello",
    mimeType: "text/html",
    size: 2500,
  });
  try {
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(api.getById).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain("Ukrainian Hello");
  } finally {
    await view.cleanup();
  }
});

it("falls back to the plain row in muse mode for a non-previewable kind", async () => {
  const view = await renderCard({
    target: { botId: "bot-1" },
    artifactId: "artifact-3",
    name: "Q3 report.pdf",
    mimeType: "application/pdf",
    size: 10240,
    museMode: true,
  });
  try {
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(api.getById).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain("Q3 report.pdf");
  } finally {
    await view.cleanup();
  }
});
