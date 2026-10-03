import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// A stand-in for the static SVG Muse face, so this test covers Bloop's own wrapper only.
vi.mock("@aiden/ui-web", () => ({
  MuseAvatar: ({
    state,
    waitingCount,
    faceHidden,
  }: {
    state: string;
    waitingCount: number;
    faceHidden?: boolean;
  }) => (
    <div
      className="aiden-muse-avatar"
      data-muse-state={state}
      data-asks={waitingCount}
      data-hidden={String(!!faceHidden)}
    />
  ),
  cn: (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" "),
  MUSE_FACE_CHEEK: "#FF8E86",
  MUSE_FACE_INK: "#132320",
  MUSE_FACE_SHINE: "#FFFFFF",
}));

import { BloopAvatar } from "./BloopAvatar";

const base = { color: "#0090FF", identity: "muse", waitingCount: 0 } as const;

describe("BloopAvatar", () => {
  it("renders the static Muse face first, with state and asks, so it works without WebGL", () => {
    const html = renderToString(
      <BloopAvatar {...base} size={120} state="thinking" waitingCount={3} />,
    );

    expect(html).toContain('data-bloop="loading"');
    expect(html).toContain('data-muse-state="thinking"');
    expect(html).toContain('data-asks="3"');
    expect(html).toContain('data-hidden="false"');
  });

  it("keeps the canvas decorative and larger than the layout box so props have room", () => {
    const html = renderToString(<BloopAvatar {...base} size={100} state="idle" />);

    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("<canvas");
    expect(html).toContain("width:210px");
    expect(html).toContain("width:100px");
  });

  it("frames small faces tight, since props would be unreadable specks", () => {
    const html = renderToString(<BloopAvatar {...base} size={20} state="idle" />);

    expect(html).toContain("width:30px");
    expect(html).toContain("width:20px");
  });
});
