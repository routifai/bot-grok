// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { AuroraBackground } from "./AuroraBackground";

let container: HTMLDivElement | null = null;

afterEach(() => {
  if (container) {
    document.body.removeChild(container);
    container = null;
  }
});

// jsdom has no WebGL, so AuroraBackground must never reach for `three` here — it should
// stay on its static CSS gradient fallback, built only from the semantic tokens.
it("renders a static fallback and cleans up on unmount when WebGL is unavailable", async () => {
  expect(window.WebGLRenderingContext).toBeUndefined();

  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<AuroraBackground />);
  });

  const wrapper = container.querySelector('[data-testid="aurora-background"]');
  expect(wrapper).not.toBeNull();
  expect(wrapper?.getAttribute("aria-hidden")).toBe("true");
  expect(wrapper?.getAttribute("style")).toContain("var(--background)");

  const canvas = wrapper?.querySelector("canvas");
  expect(canvas).not.toBeNull();

  // Unmounting must not throw even though WebGL init never ran.
  await act(async () => {
    root.unmount();
  });
  expect(container.querySelector('[data-testid="aurora-background"]')).toBeNull();
});
