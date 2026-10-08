import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("settings: Nova, General, Model, Memory and Voice, one size, iOS rows", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const userName = `Settings shell ${stamp}`;
  await signup(page, `settings-shell-${stamp}@nova.test`, "password12", userName);
  await completeOnboarding(page);

  const settings = await openUserSettings(page);
  const nav = settings.getByTestId("settings-nav");
  await expect(nav.getByRole("button")).toHaveText(["Nova", "General", "Model", "Memory", "Voice"]);
  await expect(settings.getByTestId("settings-nav-general")).toHaveAttribute(
    "aria-current",
    "page",
  );

  // General: account rows, a collapsed password form, streaming, and Log out.
  await expect(settings.getByText(userName, { exact: true })).toBeVisible();
  await expect(settings.getByLabel("Current password")).toHaveCount(0);
  await settings.getByRole("button", { name: "Change password" }).click();
  await expect(settings.getByLabel("Current password")).toBeVisible();
  const streamReplies = settings.getByTestId("response-streaming-toggle");
  await expect(streamReplies).not.toBeChecked();
  await streamReplies.click();
  await expect(streamReplies).toBeChecked();
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("nova.responseStreaming")))
    .toBe("on");
  await expect(settings.getByRole("button", { name: "Log out", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-general");
  const size = await settings.boundingBox();

  await settings.getByTestId("settings-nav-models").click();
  await expect(settings).toHaveAttribute("data-settings-section", "models");
  await expect(settings.getByText("Models and their keys are set on the server")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-model");

  await settings.getByTestId("settings-nav-voice").click();
  await expect(settings).toHaveAttribute("data-settings-section", "voice");
  await expect(settings.getByText("Service", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-voice");

  // Every section keeps the dialog the same size.
  expect(await settings.boundingBox()).toEqual(size);

  await page.getByRole("button", { name: "Close voice settings" }).click();
  await expect(page.getByTestId("user-settings")).toHaveCount(0);
});
