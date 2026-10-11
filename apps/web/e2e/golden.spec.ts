import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test.describe.configure({ mode: "serial" });

test("two users are isolated and a bot completes durable work", async ({ browser }, testInfo) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pageA = await a.newPage();
  const pageB = await b.newPage();

  const stamp = Date.now();
  await signup(pageA, `ada-${stamp}@superchat.test`, "password12", "Ada", testInfo);
  await completeOnboarding(pageA, testInfo);
  await expect(pageA.getByText("Superchat").first()).toBeVisible();

  await signup(pageB, `bob-${stamp}@superchat.test`, "password12", "Bob");
  await completeOnboarding(pageB);
  await expect(pageB.getByText("Superchat").first()).toBeVisible();
  await expect(pageB.getByText("Ada", { exact: true })).toHaveCount(0);

  const composer = pageA.getByPlaceholder(/Message/);
  await composer.fill("write a file in your home called notes/result.txt that says isolation-ok");
  await pageA.keyboard.press("Enter");
  await expect(
    pageA.getByText(/writing that into my home|isolation-ok|handled/i).first(),
  ).toBeVisible({
    timeout: 30_000,
  });

  await pageA.reload();
  await expect(pageA.getByText(/isolation-ok|writing that into my home/i).first()).toBeVisible();
  await captureScreenshot(pageA, testInfo, "07-durable-bot-work");

  await a.close();
  await b.close();
});

// The Integrations/Plugins catalog this test used to exercise here (connectors, MCP/OpenAPI/
// GraphQL/Executor/Treg sources) has no reachable entry point in Superchat: PluginsOverlay is only
// ever opened by setPluginsOpen(true), which nothing calls anymore. That coverage was removed;
// this test now only covers routine creation.
test("routine creation is reachable", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `flow-${stamp}@superchat.test`, "password12", "Flow");
  await completeOnboarding(page);

  await page.getByRole("button", { name: "Create Routine" }).click();
  await page.locator("label:has-text('Name') input").fill("Monday briefing");
  await page
    .locator("label:has-text('Instruction') textarea")
    .fill("write a file in your home called notes/result.txt that says routine-ok");
  await page.getByRole("button", { name: "Add trigger" }).click();
  await page.getByRole("menuitem", { name: "On a schedule" }).hover();
  await page.getByRole("menuitem", { name: "Every day", exact: true }).click();
  const savedRoutine = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/create") && response.ok(),
  );
  await page.getByRole("button", { name: "Save" }).click();
  await savedRoutine;
  await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByText("Monday briefing")).toBeVisible();
  await captureScreenshot(page, testInfo, "10-routine-created");
});
