import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "@playwright/test";

const fixture = "/e2e/fixtures/response-streaming.html";

async function openFixture(page: Page, query: { stream: "on" | "off" }) {
  await page.goto(`${fixture}?${new URLSearchParams({ stream: query.stream })}`);
  await expect(page.getByTestId("user-settings")).toBeVisible();
}

async function writeShot(testInfo: TestInfo, name: string, sourcePath: string) {
  await testInfo.attach(name, { contentType: "image/png", path: sourcePath });
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    path: screenshotPath,
  });
  await writeShot(testInfo, name, screenshotPath);
}

test("settings overlay keeps Stream replies inside Advanced", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFixture(page, { stream: "off" });
  const settings = page.getByTestId("user-settings");
  await expect(settings.getByRole("heading", { name: "Replies", exact: true })).toHaveCount(0);
  await expect(settings.getByTestId("response-streaming-toggle")).toBeHidden();
  await settings.getByTestId("advanced-settings").locator("summary").click();
  const streamReplies = settings.getByTestId("response-streaming-toggle");
  await expect(streamReplies).toBeVisible();
  await expect(streamReplies).not.toBeChecked();
  await expect(settings.getByText("Stream replies", { exact: true })).toBeVisible();
  await streamReplies.scrollIntoViewIfNeeded();
  await capture(page, testInfo, "settings-stream-off");

  await openFixture(page, { stream: "on" });
  const settingsOn = page.getByTestId("user-settings");
  await settingsOn.getByTestId("advanced-settings").locator("summary").click();
  const onToggle = settingsOn.getByTestId("response-streaming-toggle");
  await expect(onToggle).toBeVisible();
  await expect(onToggle).toBeChecked();
  await capture(page, testInfo, "settings-stream-on");
});
