import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";
import { AGENT_REPLY_TIMEOUT, send, signupToConversation } from "./muse-helpers";

test("multi-step work ends with a skill offer that saves to the Library", async ({
  page,
}, testInfo) => {
  await signupToConversation(page);

  await send(page, "Gather prime rates into three notes");
  await expect(page.getByText("done. three notes are in my home.")).toBeVisible({
    timeout: AGENT_REPLY_TIMEOUT,
  });

  // The quiet follow-up turn posts the offer as an Ask and says nothing else.
  const offer = page.getByText('Save "gather-prime-rates" as a skill?');
  await expect(offer).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("NO_RESPONSE")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "muse-skill-offer");

  await page.getByRole("button", { name: "Save skill" }).click();
  await expect(page.getByText("Answered: Saved")).toBeVisible();
  // The silent follow-up leaves no working indicator behind.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(3_000);
  await captureScreenshot(page, testInfo, "muse-skill-saved");

  await page
    .getByRole("link", { name: "Library" })
    .or(page.getByRole("button", { name: "Library" }))
    .first()
    .click();
  await page
    .getByRole("tab", { name: "Skills" })
    .or(page.getByRole("button", { name: "Skills" }))
    .first()
    .click();
  await expect(page.getByText("gather-prime-rates")).toBeVisible();
  await captureScreenshot(page, testInfo, "muse-library-skills");
});
