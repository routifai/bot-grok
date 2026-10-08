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
  // Resolved (rather than a bare `vi.fn()`) so the dialog can actually mount its
  // preview once opened, the way the real fetch would.
  fetchArtifactBytes: vi.fn().mockResolvedValue(new Uint8Array()),
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
  const cn = (...args: unknown[]) => args.filter(Boolean).join(" ");
  const Passthrough = ({ children, ...props }: ComponentProps<"div">) => (
    <div {...props}>{children}</div>
  );
  return {
    cn,
    buttonVariants: () => "",
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

function buttonsNamed(container: HTMLElement, name: string): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")].filter(
    (button) => button.getAttribute("aria-label") === name,
  );
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

it("shows the same live preview as the Library for a freshly attached HTML artifact, with a quiet meta line instead of an eyebrow", async () => {
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
    // The result tile: the kind as its brand line, and "Kind • size" beside the Open pill.
    expect(view.container.querySelector('[data-testid="media-tile"]')).toBeTruthy();
    expect(view.container.textContent).toContain("Page • 2.4 KB");
    expect(view.container.textContent).not.toContain("PAGE");
  } finally {
    await view.cleanup();
  }
});

it("gives the open and download actions accessible names, and opens the preview dialog when clicked", async () => {
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
    const openAction = buttonsNamed(view.container, "Open Ukrainian Hello");
    const downloadAction = buttonsNamed(view.container, "Download Ukrainian Hello");
    expect(openAction).toHaveLength(1);
    expect(downloadAction).toHaveLength(1);

    // The dialog isn't mounted until it's opened.
    expect(view.container.querySelector('[aria-label="Close preview"]')).toBeNull();

    await act(async () => {
      openAction[0]?.click();
    });

    expect(view.container.querySelector('[aria-label="Close preview"]')).toBeTruthy();
    // The dialog's own header adds a second, independent download control.
    expect(buttonsNamed(view.container, "Download Ukrainian Hello")).toHaveLength(2);
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

it("gives a PDF the same muse card, with its type icon and no thumbnail fetch", async () => {
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
    expect(buttonsNamed(view.container, "Open Q3 report.pdf")).toHaveLength(1);
    expect(buttonsNamed(view.container, "Download Q3 report.pdf")).toHaveLength(1);
  } finally {
    await view.cleanup();
  }
});
