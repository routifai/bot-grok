// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../test/i18n")).withI18nRoot(await orig<typeof import("react-dom/client")>()),
);

const api = vi.hoisted(() => ({
  get: vi.fn(),
  updateDraft: vi.fn(),
  save: vi.fn(),
  testRun: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({ rpc: { skills: api } }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((out, part, i) => out + part + (values[i] ?? ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("../ai/primitives", () => ({
  Shimmer: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@nova/ui-web", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Sheet: Box,
    SheetContent: Box,
    SheetHeader: Box,
    SheetTitle: Box,
    SheetDescription: Box,
    Label: Box,
    Button: ({
      variant: _v,
      size: _s,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
    Switch: ({
      checked,
      onCheckedChange,
      "aria-label": label,
    }: {
      checked: boolean;
      onCheckedChange: (value: boolean) => void;
      "aria-label"?: string;
    }) => (
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        onClick={() => onCheckedChange(!checked)}
      />
    ),
  };
});

import { SkillReviewSheet } from "./SkillReviewSheet";

const draft = {
  preconditions: [],
  inputs: [{ name: "product", label: "Product", default: "laptop stand" }],
  steps: [
    { intent: "Search for {{product}}", check: "Results", approval: false, keyframe: "k1" },
    { intent: "Buy it", check: "Receipt", approval: true, keyframe: null },
  ],
  returns: "",
};
const skill = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  botId: "b1",
  name: "Search",
  goal: "Find a product",
  status: "draft",
  playbook: {},
  draft,
  keyframes: { k1: "data:image/jpeg;base64,AAA" },
  updatedAt: "2026-10-04T00:00:00.000Z",
  ...over,
});

const mounted: { root: ReturnType<typeof createRoot>; container: HTMLElement }[] = [];
async function mount(onChanged = vi.fn(), onOpenChange = vi.fn()) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      <SkillReviewSheet skillId="s1" open onOpenChange={onOpenChange} onChanged={onChanged} />,
    );
  });
  return { container, onChanged, onOpenChange };
}
const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.clearAllMocks();
});

it("shows the draft being written, with no actions yet", async () => {
  api.get.mockResolvedValue(skill({ status: "drafting", draft: null }));
  const { container } = await mount();
  expect(container.textContent).toContain("Writing the draft…");
  expect(button(container, "Save")).toBeUndefined();
  expect(button(container, "Discard")).toBeDefined();
});

it("lists steps with their keyframe, saves edits and keeps the skill", async () => {
  api.get.mockResolvedValue(skill());
  api.updateDraft.mockResolvedValue(skill());
  api.save.mockResolvedValue(skill({ status: "saved" }));
  const { container, onChanged } = await mount();
  expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,AAA");
  expect(container.querySelectorAll("img")).toHaveLength(1);
  const buy = container.querySelector('[aria-label="Ask me first before step 2"]');
  expect(buy?.getAttribute("aria-checked")).toBe("true");

  const first = container.querySelector('textarea[aria-label="Step 1"]') as HTMLTextAreaElement;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    set?.call(first, "Search the shop for {{product}}");
    first.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    (container.querySelector('[aria-label="Remove step 2"]') as HTMLElement).click();
  });
  await act(async () => {
    button(container, "Save")?.click();
  });
  const sent = api.updateDraft.mock.calls[0]?.[0];
  expect(sent.skillId).toBe("s1");
  expect(sent.draft.steps).toHaveLength(1);
  expect(sent.draft.steps[0].intent).toBe("Search the shop for {{product}}");
  expect(api.save).toHaveBeenCalledWith({ skillId: "s1", name: "Search" });
  expect(onChanged).toHaveBeenCalled();
});

it("test run saves the edits first and closes the sheet; discard removes it", async () => {
  api.get.mockResolvedValue(skill());
  api.updateDraft.mockResolvedValue(skill());
  api.testRun.mockResolvedValue({ runId: "r1" });
  api.remove.mockResolvedValue({ ok: true });
  const { container, onOpenChange } = await mount();
  await act(async () => {
    button(container, "Test")?.click();
  });
  expect(api.updateDraft).toHaveBeenCalledBefore(api.testRun);
  expect(api.testRun).toHaveBeenCalledWith({ skillId: "s1" });
  expect(onOpenChange).toHaveBeenCalledWith(false);
  await act(async () => {
    button(container, "Discard")?.click();
  });
  expect(api.remove).toHaveBeenCalledWith({ skillId: "s1" });
});
