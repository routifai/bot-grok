// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../test/i18n")).withI18nRoot(await orig<typeof import("react-dom/client")>()),
);

import { PlanSteps } from "./PlanSteps";
import type { PlanStep } from "./workPlan";

const mounted: Array<() => void> = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

async function mount(node: ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(() => act(() => root.unmount()));
  await act(async () => root.render(node));
  return container;
}

const step = (
  text: string,
  status: PlanStep["status"],
  over: Partial<PlanStep> = {},
): PlanStep => ({
  text,
  status,
  added: false,
  engine: true,
  ...over,
});

const rows = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-testid=work-plan-step]")].map((li) => ({
    status: li.getAttribute("data-status"),
    text: li.querySelector(".sc-work-in")?.textContent,
    reading: li.querySelector("[data-testid=work-plan-reading]")?.textContent ?? null,
  }));

it("draws each engine state: doing in its present tense, readings for the ones that are not plain", async () => {
  const container = await mount(
    <PlanSteps
      progress="Slide 2 of 4"
      plan={[
        step("Check what we have", "done"),
        step("Build the deck", "doing", { active: "Building the deck" }),
        step("Write the notes", "claimed"),
        step("Check the figures", "not_checked"),
        step("Export it", "stopped"),
        step("Send it", "failed"),
        step("Tidy up", "todo"),
      ]}
    />,
  );
  expect(rows(container)).toEqual([
    { status: "done", text: "Check what we have", reading: null },
    { status: "doing", text: "Building the deck", reading: null },
    // The model's tick with nothing behind it reads as to do.
    { status: "claimed", text: "Write the notes", reading: null },
    { status: "not_checked", text: "Check the figures", reading: "Not checked" },
    { status: "stopped", text: "Export it", reading: "Stopped" },
    { status: "failed", text: "Send it", reading: "Didn't finish" },
    { status: "todo", text: "Tidy up", reading: null },
  ]);
  const claimed = container.querySelector("[data-status=claimed]");
  const todo = container.querySelector("[data-status=todo]");
  expect(claimed?.className).toBe(todo?.className);
  expect(
    container.querySelector("[data-status=not_checked] [data-testid=work-plan-reading]")?.className,
  ).toContain("text-warning");
  expect(container.querySelector("[data-testid=work-plan-progress]")?.textContent).toBe(
    "Slide 2 of 4",
  );
  // Full (the panel): every step, no "Then" line.
  expect(container.querySelector("[data-testid=work-plan-then]")).toBeNull();
});

it("compact, stops at the current step and names the next one to do", async () => {
  const container = await mount(
    <PlanSteps
      compact
      progress={null}
      plan={[
        step("Read", "done"),
        step("Build", "doing", { active: "Building" }),
        step("Notes", "claimed"),
        step("Check", "todo"),
      ]}
    />,
  );
  expect(rows(container).map((row) => row.text)).toEqual(["Read", "Building"]);
  expect(container.querySelector("[data-testid=work-plan-then]")?.textContent).toBe("Then: Notes");
});

it("folds the earlier done steps the engine counts, behind a toggle", async () => {
  const container = await mount(
    <PlanSteps
      fold={2}
      progress={null}
      plan={[
        step("One", "done"),
        step("Two", "done"),
        step("Three", "done"),
        step("Four", "done"),
        step("Five", "doing"),
      ]}
    />,
  );
  const toggle = container.querySelector<HTMLButtonElement>("[data-testid=work-plan-fold]");
  expect(toggle?.textContent).toBe("2 earlier steps");
  expect(toggle?.getAttribute("aria-expanded")).toBe("false");
  expect(rows(container).map((row) => row.text)).toEqual(["Three", "Four", "Five"]);
  await act(async () => toggle?.click());
  expect(toggle?.textContent).toBe("Hide earlier steps");
  expect(rows(container).map((row) => row.text)).toEqual(["One", "Two", "Three", "Four", "Five"]);
  await act(async () => toggle?.click());
  expect(rows(container)).toHaveLength(3);
});

it("offers Comment on each step, naming the step and its place", async () => {
  const onComment = vi.fn();
  const container = await mount(
    <PlanSteps
      progress={null}
      onComment={onComment}
      plan={[step("Read", "done"), step("Build", "doing")]}
    />,
  );
  const buttons = container.querySelectorAll<HTMLButtonElement>("[data-testid=work-plan-comment]");
  expect(buttons).toHaveLength(2);
  expect(buttons[1]?.textContent).toBe("Comment");
  expect(buttons[1]?.getAttribute("aria-label")).toBe("Comment on Build");
  await act(async () => buttons[1]?.click());
  expect(onComment).toHaveBeenCalledWith(1, expect.objectContaining({ text: "Build" }));
});

it("never folds the step the work is on, nor anything without the engine's count", async () => {
  const container = await mount(
    <PlanSteps fold={5} progress={null} plan={[step("One", "done"), step("Two", "doing")]} />,
  );
  expect(container.querySelector("[data-testid=work-plan-fold]")?.textContent).toBe(
    "1 earlier step",
  );
  expect(rows(container).map((row) => row.text)).toEqual(["Two"]);
  const unfolded = await mount(
    <PlanSteps
      progress={null}
      plan={[step("One", "done"), step("Two", "done"), step("Three", "done")]}
    />,
  );
  expect(unfolded.querySelector("[data-testid=work-plan-fold]")).toBeNull();
});

it("shows Comment without hover on a touch screen", async () => {
  const container = await mount(
    <PlanSteps progress={null} onComment={() => undefined} plan={[step("Read", "done")]} />,
  );
  expect(container.querySelector("[data-testid=work-plan-comment]")?.className).toContain(
    "[@media(hover:none)]:opacity-100",
  );
});
