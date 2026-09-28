import type { Routine } from "@aiden/contracts";
import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("Slack message trigger uses the mounted messaging provider and persists", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/messaging/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: { enabled: true, providers: ["slack"], openSignup: false, identities: [] },
      }),
    }),
  );
  const stamp = Date.now();
  await signup(page, `routine-slack-${stamp}@aiden.test`, "password12", "Slack Routine");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await page.getByTitle("Agent computer").click();
  await page.getByRole("button", { name: "Create Routine" }).click();
  await page.getByPlaceholder("Name this routine").fill("Triage Slack updates");
  await page
    .getByPlaceholder("What should this routine do each time it runs?")
    .fill("Review the verified message event");
  await page.getByRole("button", { name: "Add trigger" }).click();
  await page.getByRole("menuitem", { name: "Slack message", exact: true }).click();

  const panel = page.getByTestId("side-panel");
  await expect(panel.getByText("Slack message", { exact: true })).toBeVisible();
  await expect(
    panel.getByText("Runs when this bot receives a verified message from this provider."),
  ).toBeVisible();

  const saved = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/create") && response.ok(),
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await saved;
  const [routine] = await rpc<Routine[]>(page, "routines/list", { botId });
  expect(routine).toMatchObject({
    name: "Triage Slack updates",
    crons: [],
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: "slack",
  });
  await captureScreenshot(page, testInfo, "routine-slack-message");
});

test("GitHub event trigger exposes signed delivery settings and persists", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `routine-github-${stamp}@aiden.test`, "password12", "GitHub Routine");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await page.getByTitle("Agent computer").click();
  await page.getByRole("button", { name: "Create Routine" }).click();
  await page.getByPlaceholder("Name this routine").fill("Review repository events");
  await page
    .getByPlaceholder("What should this routine do each time it runs?")
    .fill("Inspect the signed GitHub event");
  await page.getByRole("button", { name: "Add trigger" }).click();
  await page.getByRole("menuitem", { name: "Git event", exact: true }).click();

  await expect(
    page.getByTestId("side-panel").getByText("Git event", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(new RegExp(`/api/v1/bots/${botId}/github$`))).toBeVisible();
  await expect(page.getByText("X-Hub-Signature-256: sha256=…", { exact: true })).toBeVisible();

  const saved = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/create") && response.ok(),
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await saved;
  const [routine] = await rpc<Routine[]>(page, "routines/list", { botId });
  expect(routine).toMatchObject({
    name: "Review repository events",
    crons: [],
    webhookEnabled: false,
    githubEnabled: true,
  });
  await captureScreenshot(page, testInfo, "routine-github-event");
});

test("routine test-run completes and survives reload", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `routine-${stamp}@aiden.test`, "password12", "Routine");
  await completeOnboarding(page);

  await page.getByTitle("Agent computer").click();
  await expect(page.getByRole("button", { name: "Test run" })).toHaveCount(0);
  await page.getByRole("button", { name: "Create Routine" }).click();
  await page.locator("label:has-text('Name') input").fill("Daily verification");
  await page
    .locator("label:has-text('Instruction') textarea")
    .fill("write routine-run-now-ok into the durable task result");
  await page.getByRole("button", { name: "Add trigger" }).click();
  await page.getByRole("menuitem", { name: "On a schedule" }).hover();
  await page.getByRole("menuitem", { name: "Weekdays", exact: true }).click();
  await expect(page.getByLabel("How often")).toHaveValue("Weekdays");
  await captureScreenshot(page, testInfo, "32-routine-configured");

  const saved = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/create") && response.ok(),
  );
  await page.getByRole("button", { name: "Save" }).click();
  await saved;
  await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
  await page.getByRole("button", { name: "Back" }).click();
  const routine = page.getByRole("button", { name: /Daily verification/ });
  await expect(routine).toContainText("Weekdays at 9:00 AM");
  await captureScreenshot(page, testInfo, "33-routine-scheduled");

  await routine.click();
  await page.getByRole("button", { name: "Test run" }).click();
  await expect(page.getByText(/routine-run-now-ok/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 30_000 });
  await captureScreenshot(page, testInfo, "34-routine-run-completed");

  await page.reload();
  await expect(page.getByText(/routine-run-now-ok/i).first()).toBeVisible();
  await page.getByTitle("Agent computer").click();
  await expect(page.getByRole("button", { name: /Daily verification/ })).toContainText(
    "Weekdays at 9:00 AM",
  );
  await captureScreenshot(page, testInfo, "35-routine-run-persisted");
});
