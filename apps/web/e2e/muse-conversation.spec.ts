import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";
import { AGENT_REPLY_TIMEOUT, send, signupToConversation } from "./muse-helpers";

test("a new person lands in the Conversation and gets a reply", async ({ page }, testInfo) => {
  await signupToConversation(page);
  await captureScreenshot(page, testInfo, "muse-welcome");

  await send(page, "Write a note called hello.md that says good morning");
  await expect(page.getByText("writing that into my home now.")).toBeVisible({
    timeout: AGENT_REPLY_TIMEOUT,
  });
  await captureScreenshot(page, testInfo, "muse-reply");
});
