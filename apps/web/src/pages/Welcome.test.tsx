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
});

it("tells the week in nine beats, all visible under reduced motion", async () => {
  await render();
  const beats = [...host.querySelectorAll("[data-day]")];
  expect(beats).toHaveLength(9);
  expect(beats.every((b) => b.getAttribute("data-in") === "true")).toBe(true);
  const text = host.textContent ?? "";
  for (const part of [
    "Prep me for Thursday's review with Northwind",
    "Email · 4 threads",
    "Take over",
    "you were in meetings",
    "Remembered from July",
    "Saved as v2",
    "forked from this message",
    "Knows our conversation",
    "Saved skill",
    "starts in 15 minutes",
    "Send the follow-up to Maya?",
    "Sent",
  ]) {
    expect(text).toContain(part);
  }
  const shot = host.querySelector("img");
  expect(shot?.getAttribute("alt")).toBe(
    "Nova's computer: a browser open on the Northwind account in a CRM",
  );
  expect(shot?.getAttribute("width")).toBe("1280");
  expect(shot?.getAttribute("loading")).toBe("lazy");
});

it("reveals the first beat at once, without scrolling, and the rest on arrival", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  await render();
  const beats = [...host.querySelectorAll("[data-day]")];
  expect(beats.map((b) => b.getAttribute("data-in"))).toEqual(["true", ...Array(8).fill("false")]);
});

it("has the enterprise section with its eight items", async () => {
  await render();
  const titles = [...host.querySelectorAll("li h3")].map((h) => h.textContent);
  expect(titles).toEqual([
    "Runs where you choose",
    "Your model",
    "Your harness",
    "A computer you host",
    "Memory per person",
    "Secrets stay sealed",
    "Approvals you set",
    "Every step on record",
  ]);
  expect(host.textContent).toContain("Ready for your company.");
});

it("loads no video until the film button is pressed, then shows it in a dialog", async () => {
  await render();
  expect(document.querySelector("video")).toBeNull();
  const button = [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Watch the 47-second film"),
  );
  expect(button).toBeDefined();
  await act(async () => {
    button?.click();
  });
  const video = document.querySelector("video");
  expect(video?.getAttribute("poster")).toContain("welcome/nova-film-poster.jpg");
  expect(video?.getAttribute("preload")).toBe("none");
  const track = video?.querySelector("track");
  expect(track?.getAttribute("kind")).toBe("captions");
  expect(track?.getAttribute("src")).toContain("nova-film.en.vtt");
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
});
