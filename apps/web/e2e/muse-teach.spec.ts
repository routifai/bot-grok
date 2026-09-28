import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";
import { AGENT_REPLY_TIMEOUT, signupToConversation } from "./muse-helpers";

test("teach a task records a demonstration, saves it and tests it", async ({ page }, testInfo) => {
  await signupToConversation(page);

  await page.getByTitle("Agent computer").click();
  const sidePanel = page.getByTestId("side-panel");
  await expect(sidePanel).toHaveAttribute("data-panel", "computer");
  const preview = sidePanel.getByTestId("computer-preview");
  await preview.hover();
  await sidePanel.getByTestId("computer-preview-open").click();

  const chrome = page.getByTestId("computer-chrome");
  await chrome.getByTestId("teach-start-button").click();
  await page.getByTestId("teach-goal-input").fill("Search the web for mortgage rates");
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(page.getByTestId("teach-recording-overlay")).toBeVisible();
  await captureScreenshot(page, testInfo, "muse-teach-recording");

  await page.getByTestId("teach-capture-overlay").click({ position: { x: 200, y: 200 } });
  await page.keyboard.type("mortgage rates");
  await page.keyboard.press("Enter");
  await page.getByTestId("teach-stop-overlay").click();

  const draft = page.getByTestId("skill-draft-card");
  await expect(draft).toBeVisible({ timeout: 20_000 });
  await captureScreenshot(page, testInfo, "muse-teach-draft");
  await draft.getByRole("button", { name: "Save" }).click();
  await expect(draft.getByRole("button", { name: "Saved" })).toBeVisible();

  await draft.getByRole("button", { name: "Test" }).click();
  await expect(
    page.getByText("Running the taught skill using its saved playbook.", { exact: false }),
  ).toBeVisible({ timeout: AGENT_REPLY_TIMEOUT });
  await captureScreenshot(page, testInfo, "muse-teach-tested");
});
