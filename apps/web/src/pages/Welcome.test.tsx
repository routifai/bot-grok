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
  expect(host.querySelector("h1")?.textContent).toContain("Nova's already on it.");
  const hrefs = (label: string) =>
    [...host.querySelectorAll("a")]
      .filter((a) => a.textContent === label)
      .map((a) => a.getAttribute("href"));
  expect(hrefs("Get started")).toEqual(["/sign-up", "/sign-up", "/sign-up"]);
  expect(hrefs("I have an account")).toEqual(["/sign-in"]);
  expect(hrefs("Sign in")).toEqual(["/sign-in"]);
  expect(host.firstElementChild?.getAttribute("data-nova-surface")).toBe("welcome");
});

it("lights the whole statement under reduced motion", async () => {
  await render();
  const words = [...host.querySelectorAll("section[aria-label] p span span")];
  expect(words.length).toBeGreaterThan(10);
  expect(words.every((w) => w.className.endsWith("text-welcome-night-ink"))).toBe(true);
});

it("has the six demo cards, and plays the front one", async () => {
  await render();
  const titles = [...host.querySelectorAll("section h3")].map((h) => h.textContent);
  expect(titles).toEqual(["Remember", "Branch", "Work", "Learn", "Create", "Ask"]);
  expect(host.textContent).toContain("See it work.");
  // Reduced motion shows the front card finished at once.
  expect(host.textContent).toContain("Maya likes a one-page summary");
});

it("plays the film in place, with captions, and closes it again", async () => {
  await render();
  const video = host.querySelector("video");
  expect(video?.getAttribute("src")).toBe("/welcome/hero-loop.mp4");
  expect(video?.querySelector("track")?.getAttribute("src")).toContain("nova-film.en.vtt");
  const button = [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Watch the film"),
  );
  expect(button?.textContent).toContain("0:47");
  await act(async () => {
    button?.click();
  });
  expect(host.querySelector("video")?.getAttribute("src")).toBe("/welcome/nova-film.mp4");
  const close = [...host.querySelectorAll("button")].find((b) => b.textContent === "Close");
  await act(async () => {
    close?.click();
  });
  expect(host.querySelector("video")?.getAttribute("src")).toBe("/welcome/hero-loop.mp4");
});
