import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("account settings appearance control switches to light mode", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `ui-appearance-${stamp}@nova.test`, "password12", "Appearance QA");
  await completeOnboarding(page, testInfo);

  const settings = await openUserSettings(page);
  await expect(settings.getByRole("heading", { name: "Appearance", exact: true })).toBeVisible();

  const picker = settings.getByTestId("ui-appearance");
  await expect(picker).toBeVisible();
  await captureScreenshot(page, testInfo, "ui-appearance-control");

  await settings.getByTestId("ui-appearance-light").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(settings.getByTestId("ui-appearance-light")).toHaveAttribute("aria-pressed", "true");
  await captureScreenshot(page, testInfo, "ui-appearance-light-settings");

  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await captureScreenshot(page, testInfo, "ui-appearance-light-shell");
  await captureScreenshot(page, testInfo, "sidebar-search-selected-light");

  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill("Please review `shared/PROJECT_CHECKPOINT_WRAPUP.md`.");
  await composer.press("Enter");
  const assistantReply = page
    .getByTestId("transcript")
    .locator("[data-message-id]")
    .filter({ hasText: "done. i handled:" });
  const inlinePath = assistantReply
    .locator("code")
    .filter({ hasText: "shared/PROJECT_CHECKPOINT_WRAPUP.md" });
  await expect(inlinePath).toBeVisible({ timeout: 30_000 });
  await expect(inlinePath).toHaveCSS("color", "rgb(21, 22, 26)");
  await captureScreenshot(page, testInfo, "inline-code-light");

  await openUserSettings(page);
  await settings.getByTestId("ui-appearance-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await captureScreenshot(page, testInfo, "sidebar-search-selected-dark");
});
