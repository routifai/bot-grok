import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("a failed run is visible once without returning after reload", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `run-failure-${stamp}@nova.test`, "password12", "Run Failure");
  await completeOnboarding(page);

  // "fail this run" makes the scripted runtime throw, so the run fails the same way a
  // real provider error would, without depending on how models are configured.
  await page.getByPlaceholder(/^Message /).fill("fail this run");
  await page.getByRole("button", { name: "Send" }).click();

  const error = page.getByTestId("composer-error");
  await expect(error).toBeVisible({ timeout: 30_000 });
  await expect(error).toContainText("Scripted run failure");
  await captureScreenshot(page, testInfo, "new-run-error-visible");

  await page.reload();
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await expect(
    page.getByTestId("transcript").getByText("fail this run", { exact: true }),
  ).toBeVisible();
  await expect(error).toBeHidden();
  await captureScreenshot(page, testInfo, "seen-run-error-hidden-after-reload");

  await page.getByPlaceholder(/^Message /).fill("fail this run");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(error).toBeVisible({ timeout: 30_000 });
  await expect(error).toContainText("Scripted run failure");

  const dismissError = page.getByTestId("composer-error-dismiss");
  await dismissError.focus();
  await expect(dismissError).toBeFocused();
  await dismissError.press("Enter");
  await expect(error).toBeHidden();
  await expect(page.getByPlaceholder(/^Message /)).toBeFocused();
});
