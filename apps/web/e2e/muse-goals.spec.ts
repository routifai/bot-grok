import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";
import { AGENT_REPLY_TIMEOUT, send, signupToConversation } from "./muse-helpers";

test("a goal set up in the Conversation shows in Goals", async ({ page }, testInfo) => {
  await signupToConversation(page);

  await send(
    page,
    "Set up a goal called Q3 portfolio review with tasks: gather statements, draft summary",
  );
  // The reply streams before the tool call lands; the plan card means the Goal exists.
  await expect(page.getByText('Here\'s my plan for "Q3 portfolio review"')).toBeVisible({
    timeout: AGENT_REPLY_TIMEOUT,
  });

  await page
    .getByRole("link", { name: "Goals" })
    .or(page.getByRole("button", { name: "Goals" }))
    .first()
    .click();
  await expect(page.getByText("Q3 portfolio review").first()).toBeVisible();
  await captureScreenshot(page, testInfo, "muse-goals");
});
