import { expect, type Page, type TestInfo } from "@playwright/test";

export function isRealSandboxProvider(provider = process.env.SANDBOX_PROVIDER) {
  return provider === "e2b" || provider === "daytona" || provider === "box";
}

export function realSandboxTimeout(real: number, emulated: number) {
  if (process.env.SANDBOX_PROVIDER === "box") return Math.max(real, 300_000);
  return isRealSandboxProvider() ? real : emulated;
}

export function activeBotId(page: Page) {
  const id = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
  if (!id || id === "app") throw new Error(`missing bot id in ${page.url()}`);
  return id;
}

export async function rpc<T>(page: Page, procedure: string, body: unknown): Promise<T> {
  const response = await page.request.post(`/rpc/${procedure}`, { data: { json: body } });
  const parsed = (await response.json()) as { json?: T; error?: { message?: string } };
  if (!response.ok() || parsed.error) {
    throw new Error(`${procedure} ${response.status()}: ${parsed.error?.message ?? "failed"}`);
  }
  return parsed.json as T;
}

/**
 * Drives the Muse identity steps (intro → name → Muse name → color), each
 * pre-filled with a usable default so "Continue" is enough. Leaves the page
 * on whatever step comes after (Server integrations, model connect, or bot).
 */
export async function completeIdentitySteps(page: Page): Promise<void> {
  const intro = page.getByRole("button", { name: "Let's get started", exact: true });
  await intro.waitFor({ timeout: 20_000 });
  await intro.click();

  const continueButton = page.getByRole("button", { name: "Continue", exact: true });
  await continueButton.click(); // name (pre-filled from the signed-up account name)
  await continueButton.click(); // Muse name (pre-filled with the default name)
  await continueButton.click(); // Muse color (default color selected)
}

/**
 * Drives the Muse identity steps, then the optional Server integrations
 * step, landing in the Muse's chat with no form to fill.
 */
export async function completeOnboarding(page: Page, testInfo?: TestInfo) {
  // Sign-up lands on /app for a moment before the app sends a new person to onboarding, so
  // the URL alone can't say onboarding is done: wait for the welcome or a ready composer.
  const welcome = page.getByRole("button", { name: "Let's get started" });
  const ready = page.getByPlaceholder(/^Message /).first();
  await welcome.or(ready).waitFor({ timeout: 30_000 });
  if (await ready.isVisible().catch(() => false)) return;

  await completeIdentitySteps(page);

  const integrations = page.getByRole("heading", { name: "Server integrations", exact: true });
  const composer = page.getByPlaceholder(/^Message /).first();
  await integrations.or(composer).or(page.getByText("Opening chat…")).waitFor({ timeout: 20_000 });
  if (await integrations.isVisible().catch(() => false)) {
    if (testInfo) await captureScreenshot(page, testInfo, "02-connect-apps");
    await page.getByRole("button", { name: "Skip", exact: true }).click();
  }
  await page.waitForURL(/\/app\//, { timeout: 20_000 });
  await expect(composer).toBeVisible();
  if (testInfo) {
    await captureScreenshot(page, testInfo, "03-create-first-bot");
    await captureScreenshot(page, testInfo, "06-onboarding-complete");
  }
}

export async function signup(
  page: Page,
  email: string,
  password: string,
  name: string,
  testInfo?: TestInfo,
) {
  await page.goto("/sign-up");
  await expect(page.getByRole("heading", { name: "Meet Nova." })).toBeVisible();
  if (testInfo) await captureScreenshot(page, testInfo, "01-sign-up");
  await page.getByPlaceholder("Your name").fill(name);
  await page.getByPlaceholder("Your email address").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
}

export async function captureScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    path: screenshotPath,
  });
  await testInfo.attach(name, { contentType: "image/png", path: screenshotPath });
}

/** Open the user Settings overlay, optionally switching to a sidebar section. */
export async function openUserSettings(
  page: Page,
  section?: "general" | "signups" | "models" | "voice" | "usage" | "computer" | "updates" | "nova",
) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  if (section && section !== "general") {
    await settings.getByTestId(`settings-nav-${section}`).click();
  }
  return settings;
}
