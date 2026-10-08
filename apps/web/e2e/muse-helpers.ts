import { expect, type Page } from "@playwright/test";

/** Sign up a fresh person and wait for their Muse Conversation. */
export async function signupToConversation(page: Page, name = "Sam") {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await page.goto("/sign-up");
  await page.getByPlaceholder("Your name").fill(name);
  await page.getByPlaceholder("Your email address").fill(`muse-${stamp}@nova.test`);
  await page.getByPlaceholder("Password").fill("password12");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("button", { name: "Let's get started" }).click();
  await expect(page.getByLabel("Your name")).toHaveValue(name);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Muse name")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Pick my color.")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 30_000 });
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
}

export function composer(page: Page) {
  return page.getByPlaceholder(/^Message /);
}

export async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await page.keyboard.press("Enter");
}

/** Agent turns that touch the computer can queue behind other suites' boots. */
export const AGENT_REPLY_TIMEOUT = 60_000;
