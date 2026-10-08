// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../test/i18n")).withI18nRoot(await orig<typeof import("react-dom/client")>()),
);

import { WelcomePage } from "./Welcome";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof HTMLCanvasElement.prototype.getContext;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("reduce"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  host.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => {
    createRoot(host).render(
      <MemoryRouter>
        <WelcomePage />
      </MemoryRouter>,
    );
  });
}

it("shows the headline and links the CTAs to sign-up and sign-in", async () => {
  await render();
  expect(host.querySelector("h1")?.textContent).toContain("Hand it off.");
  const hrefs = (label: string) =>
    [...host.querySelectorAll("a")]
      .filter((a) => a.textContent === label)
      .map((a) => a.getAttribute("href"));
  expect(hrefs("Get started")).toEqual(["/sign-up", "/sign-up", "/sign-up"]);
  expect(hrefs("I have an account")).toEqual(["/sign-in", "/sign-in"]);
  expect(hrefs("Sign in")).toEqual(["/sign-in"]);
});

it("has a film with a poster and a captions track, not preloaded", async () => {
  await render();
  const video = host.querySelector("video");
  expect(video?.getAttribute("poster")).toContain("welcome/nova-film-poster.jpg");
  expect(video?.getAttribute("preload")).toBe("none");
  expect(video?.querySelector("track")?.getAttribute("kind")).toBe("captions");
  expect(host.querySelector('button[aria-label="Play the film"]')).not.toBeNull();
});

it("shows the finished conversation under reduced motion", async () => {
  await render();
  const text = host.textContent ?? "";
  expect(text).toContain("Plan me 5 days in Lisbon");
  expect(text).toContain("Hold the two flights for 24 hours?");
  expect(text).not.toContain("Comparing 6 flights");
});
