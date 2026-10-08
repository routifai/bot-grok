import { expect, type Page, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  realSandboxTimeout,
  rpc,
  signup,
} from "./helpers";

test.describe.configure({ mode: "serial" });

test("two users are isolated and a bot completes durable work", async ({ browser }, testInfo) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pageA = await a.newPage();
  const pageB = await b.newPage();

  const stamp = Date.now();
  await signup(pageA, `ada-${stamp}@nova.test`, "password12", "Ada", testInfo);
  await completeOnboarding(pageA, testInfo);
  await expect(pageA.getByText("Nova").first()).toBeVisible();

  await signup(pageB, `bob-${stamp}@nova.test`, "password12", "Bob");
  await completeOnboarding(pageB);
  await expect(pageB.getByText("Nova").first()).toBeVisible();
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
// GraphQL/Executor/Treg sources) has no reachable entry point in Nova: PluginsOverlay is only
// ever opened by setPluginsOpen(true), which nothing calls anymore. That coverage was removed;
// this test now only covers computer takeover and routine creation.
test("takeover and routine creation are reachable", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `flow-${stamp}@nova.test`, "password12", "Flow");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("install the gsc cli and sign in");
  await page.keyboard.press("Enter");
  await expect(
    page.getByText(/handing you the computer|sign in to continue|protected input/i).first(),
  ).toBeVisible({ timeout: realSandboxTimeout(90_000, 30_000) });
  await expect
    .poll(() => threadRunStatus(page), {
      timeout: realSandboxTimeout(90_000, 30_000),
      message: "the protected-input run must be ready for takeover",
    })
    .toBe("waiting_takeover");
  const computerCard = page.getByTestId("computer-card");
  await expect(computerCard).toBeVisible();
  await expect(computerCard.getByText("Needs you", { exact: true })).toBeVisible();
  await expect(computerCard.getByTestId("computer-card-open")).toBeVisible();
  await captureScreenshot(page, testInfo, "08-protected-input-request");
  await computerCard.getByTestId("computer-card-open").click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Skip", exact: true }).last()).toBeVisible();
  await expect(page.getByRole("button", { name: "I’m done", exact: true }).last()).toBeVisible();
  if (process.env.SANDBOX_PROVIDER === "box") await waitForBoxFramebuffer(page);
  await captureScreenshot(page, testInfo, "09-computer-takeover-outcomes");
  await page.getByRole("button", { name: "I’m done", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeHidden();
  await expect(page.getByText(/signed in|session stays/i).first()).toBeVisible({
    timeout: realSandboxTimeout(90_000, 30_000),
  });

  await composer.fill("sign in again so I can skip this time");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => threadRunStatus(page), {
      timeout: realSandboxTimeout(90_000, 30_000),
      message: "the second protected-input run must be ready for takeover",
    })
    .toBe("waiting_takeover");
  // Agent computer toggles the panel. Re-open when closed so Open can refresh computer status.
  const sidePanel = page.getByTestId("side-panel");
  if ((await sidePanel.getAttribute("data-panel")) === "computer") {
    await page.getByTitle("Agent computer").click();
  }
  await page.getByTitle("Agent computer").click();
  await expect(sidePanel).toHaveAttribute("data-panel", "computer");
  await expect(sidePanel).toHaveCSS("width", "520px");
  const [mainBox, panelBox] = await Promise.all([
    page.locator("main").boundingBox(),
    sidePanel.boundingBox(),
  ]);
  expect(mainBox).not.toBeNull();
  expect(panelBox).not.toBeNull();
  expect((mainBox?.x ?? 0) + (mainBox?.width ?? 0)).toBeLessThanOrEqual(panelBox?.x ?? 0);
  await sidePanel.getByTestId("computer-preview").hover();
  const openComputer = sidePanel.getByTestId("computer-preview-open");
  await expect(openComputer).toBeVisible({ timeout: 30_000 });
  await openComputer.click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await page.getByRole("button", { name: "Skip", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeHidden();
  await expect(page.getByText(/login was skipped/i).last()).toBeVisible({
    timeout: realSandboxTimeout(90_000, 30_000),
  });
  await captureScreenshot(page, testInfo, "09a-computer-takeover-skipped");

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

async function threadRunStatus(page: Page) {
  const result = await rpc<{ run?: { status?: string } | null }>(page, "threads/get", {
    botId: activeBotId(page),
  });
  return result.run?.status ?? "idle";
}

async function waitForBoxFramebuffer(page: Page) {
  await expect
    .poll(
      async () => {
        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          const canvas = frame.locator("canvas").first();
          if ((await canvas.count()) === 0) continue;
          const ready = await canvas
            .evaluate((element) => {
              const framebuffer = element as HTMLCanvasElement;
              return framebuffer.width > 0 && framebuffer.height > 0;
            })
            .catch(() => false);
          if (ready) return true;
        }
        return false;
      },
      { timeout: 60_000, message: "the Box noVNC framebuffer must be ready" },
    )
    .toBe(true);
}
