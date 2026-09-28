import { readFile } from "node:fs/promises";
import type { MemoryDocument } from "@aiden/contracts";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

test("memory notes are readable, editable, and exportable from Settings", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `knowledge-${stamp}@aiden.test`, "password12", `Knowledge ${stamp}`);
  await completeOnboarding(page);

  const settings = await openUserSettings(page, "memory");
  const panel = settings.getByTestId("memory-panel");
  await expect(panel.getByText("What I remember")).toBeVisible();

  // A new space's "About you" only holds its placeholder: it shows as empty and opens blank.
  const aboutYou = panel.getByRole("button", { name: /About you/ });
  await expect(aboutYou).toContainText("Empty");
  await aboutYou.click();
  const editor = panel.getByRole("textbox", { name: "About you" });
  await expect(editor).toHaveValue("");
  const marker = `Prefers one-page reports ${stamp}`;
  await editor.fill(marker);
  await captureScreenshot(page, testInfo, "83-memory-editor");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByRole("button", { name: /About you/ })).toContainText(marker);

  const saved = await rpc<MemoryDocument[]>(page, "memory/list", { scope: "user" });
  expect(saved).toContainEqual(expect.objectContaining({ content: marker, revision: 2 }));
  await captureScreenshot(page, testInfo, "84-memory-saved");

  const downloadPromise = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download as Markdown" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("nova-memory.md");
  expect(await readFile((await download.path())!, "utf8")).toContain(marker);
});
