// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../test/i18n")).withI18nRoot(await orig<typeof import("react-dom/client")>()),
);

const client = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock("../lib/auth", () => ({ authClient: client }));

import { isPendingApproval, PendingApprovalPage } from "./PendingApproval";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("reduce"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  for (const name of ["IntersectionObserver", "ResizeObserver"]) {
    vi.stubGlobal(
      name,
      class {
        observe() {}
        disconnect() {}
      },
    );
  }
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function render(refetch = vi.fn(async () => undefined)) {
  root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <PendingApprovalPage refetch={refetch} />
      </MemoryRouter>,
    );
  });
  return refetch;
}

it("tells the person they are waiting, with nothing to configure", async () => {
  await render();
  expect(host.querySelector("h1")?.textContent).toBe("Waiting for approval");
  expect(host.querySelector('[role="status"]')?.textContent).toBe("You can come back later.");
  expect(host.querySelector("input")).toBeNull();
});

it("rechecks the session so approval takes effect without a reload", async () => {
  vi.useFakeTimers();
  const refetch = await render();
  await act(async () => {
    vi.advanceTimersByTime(5_100);
  });
  expect(refetch).toHaveBeenCalled();
});

it("can sign out", async () => {
  await render();
  const signOut = [...host.querySelectorAll("button")].find((b) => b.textContent === "Sign out");
  await act(async () => signOut!.click());
  expect(client.signOut).toHaveBeenCalled();
});

it("treats only an explicit pending status as waiting", () => {
  expect(isPendingApproval({ status: "pending" })).toBe(true);
  expect(isPendingApproval({ status: "active" })).toBe(false);
  expect(isPendingApproval({})).toBe(false);
  expect(isPendingApproval(undefined)).toBe(false);
});
