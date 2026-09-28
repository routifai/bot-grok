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
  await signup(pageA, `ada-${stamp}@aiden.test`, "password12", "Ada", testInfo);
  await completeOnboarding(pageA, testInfo);
  await expect(pageA.getByText("Aiden").first()).toBeVisible();

  await signup(pageB, `bob-${stamp}@aiden.test`, "password12", "Bob");
  await completeOnboarding(pageB);
  await expect(pageB.getByText("Aiden").first()).toBeVisible();
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

test("takeover, routine, plugins, and export are reachable", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `flow-${stamp}@aiden.test`, "password12", "Flow");
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
  await expect(sidePanel).toHaveCSS("width", "384px");
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

  await page.getByText("Integrations").click();
  await expect(page.getByPlaceholder("Search apps")).toBeVisible();
  const featured = page.getByTestId("featured-connectors");
  await expect(featured).toContainText(
    /Gmail[\s\S]*Google Calendar[\s\S]*Google Drive[\s\S]*Slack[\s\S]*Notion/,
  );
  await expect(page.getByText("GitHub", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add Executor", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Add Treg", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Add MCP server", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Add OpenAPI", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Add GraphQL", exact: true })).toBeHidden();
  await expect(page.getByText("Tool sources", { exact: true })).toBeHidden();
  await expect(
    page.getByText("Connect apps or add Treg, MCP, and OpenAPI tool sources.", { exact: true }),
  ).toBeHidden();
  await captureScreenshot(page, testInfo, "11-plugins-catalog");

  // Nearest ancestor with an Add/Added control (featured tile or catalog row).
  const gmailRow = featured
    .getByText("Gmail", { exact: true })
    .locator("xpath=ancestor::*[.//button][1]");
  await gmailRow.getByRole("button", { name: "Add", exact: true }).click();
  await expect(gmailRow.getByRole("button", { name: "Added", exact: true })).toBeVisible();
  await expect(page.getByTestId("connection-tile-gmail")).toBeVisible();
  await captureScreenshot(page, testInfo, "11a-connected-plugins");

  await gmailRow.getByRole("button", { name: "Added", exact: true }).click();
  const detail = page.getByTestId("connection-detail");
  await expect(detail).toBeVisible();
  await expect(page.getByTestId("connection-accounts")).toBeVisible();
  await expect(page.getByTestId("connection-tools")).toBeVisible();

  await detail.getByRole("button", { name: "Add another", exact: true }).click();
  await expect(detail.getByLabel("Account label")).toHaveCount(2);
  await detail.getByLabel("Account label").nth(1).fill("Work");
  const renamed = page.waitForResponse(
    (response) => response.url().includes("connections/rename") && response.ok(),
  );
  await detail.getByLabel("Account label").nth(1).blur();
  await renamed;
  await expect(detail.getByLabel("Account label").nth(1)).toHaveValue("Work");
  await captureScreenshot(page, testInfo, "11a2-multi-account-plugins");

  await page.getByRole("button", { name: "Close integrations" }).click();
  await page.getByText("Integrations").click();
  await expect(page.getByPlaceholder("Search apps")).toBeVisible();
  const gmailTileAgain = page.getByTestId("connection-tile-gmail");
  await expect(gmailTileAgain.getByRole("button", { name: "Added", exact: true })).toBeVisible();
  await gmailTileAgain.click();
  const detailAgain = page.getByTestId("connection-detail");
  await expect(detailAgain.getByLabel("Account label")).toHaveCount(2);
  await expect(detailAgain.getByLabel("Account label").nth(1)).toHaveValue("Work");

  await detailAgain.getByRole("button", { name: "Remove", exact: true }).last().click();
  await expect(detailAgain.getByLabel("Account label")).toHaveCount(1);
  await detailAgain.getByRole("button", { name: "Uninstall", exact: true }).click();
  await expect(page.getByTestId("connection-detail")).toHaveCount(0);
  const gmailRowEmpty = page
    .getByTestId("featured-connectors")
    .getByText("Gmail", { exact: true })
    .locator("xpath=ancestor::*[.//button][1]");
  await expect(gmailRowEmpty.getByRole("button", { name: "Add", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "11b-connected-plugins-empty");

  const linearRow = page
    .getByText("Linear", { exact: true })
    .locator("xpath=ancestor::*[.//button][1]");
  const connectPopup = page.waitForEvent("popup");
  await linearRow.getByRole("button", { name: "Add", exact: true }).click();
  const popup = await connectPopup;
  await popup.close();
  await expect(linearRow.getByRole("button", { name: "Added", exact: true })).toBeVisible();
  await linearRow.getByRole("button", { name: "Added", exact: true }).click();
  const linearDetail = page.getByTestId("connection-detail");
  await expect(linearDetail).toBeVisible();
  await linearDetail.getByRole("button", { name: "Uninstall", exact: true }).click();
  await expect(page.getByTestId("connection-detail")).toHaveCount(0);
  await expect(linearRow.getByRole("button", { name: "Add", exact: true })).toBeVisible();

  const advanced = page.getByTestId("integrations-advanced");
  await advanced.evaluate((element) => {
    (element as HTMLDetailsElement).open = true;
  });
  await expect(page.getByRole("button", { name: "Manage MCP servers", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add MCP server", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add OpenAPI", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add GraphQL", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add Executor", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add Treg", exact: true })).toBeVisible();
  await expect(page.getByText("Tool sources", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "MCP servers", exact: true })).toBeHidden();
  // Thin Advanced smoke only. GraphQL install and order screenshots live in graphql-integrations.spec.ts.
  await expect(page.getByTestId("integrations-catalog-feed")).toBeVisible();
  // Catalog Search is optional chrome; add buttons stay MCP → OpenAPI → GraphQL → Executor → Treg.
  const advancedActions = advanced.getByTestId("integrations-advanced-add").locator("button");
  await expect(advancedActions).toHaveCount(5);
  await expect(advancedActions.nth(0)).toHaveText("Add MCP server");
  await expect(advancedActions.nth(1)).toHaveText("Add OpenAPI");
  await expect(advancedActions.nth(2)).toHaveText("Add GraphQL");
  await expect(advancedActions.nth(3)).toHaveText("Add Executor");
  await expect(advancedActions.nth(4)).toHaveText("Add Treg");

  const feed = page.getByTestId("integrations-catalog-feed");
  await feed.getByRole("textbox", { name: "Integration domain" }).fill("github.com");
  await feed.getByRole("button", { name: "Search", exact: true }).click();
  await expect(feed.getByText("GitHub", { exact: true })).toBeVisible();
  await expect(feed.getByRole("button", { name: "MCP · Add", exact: true })).toBeVisible();
  await expect(feed.getByRole("button", { name: "OPENAPI · Add", exact: true })).toBeVisible();
  await expect(feed.getByRole("button", { name: "GRAPHQL · Manual", exact: true })).toBeDisabled();
  await expect(feed.getByRole("button", { name: "CLI · Manual", exact: true })).toBeDisabled();
  // Editing the query must drop prior results so a stale Add cannot run for the old domain.
  await feed.getByRole("textbox", { name: "Integration domain" }).fill("gitlab.com");
  await expect(feed.getByText("GitHub", { exact: true })).toBeHidden();
  await feed.getByRole("textbox", { name: "Integration domain" }).fill("github.com");
  await feed.getByRole("button", { name: "Search", exact: true }).click();
  await expect(feed.getByText("GitHub", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "11c-catalog-feed");

  await feed.getByRole("button", { name: "MCP · Add", exact: true }).click();
  await expect(page.getByPlaceholder("Display name")).toHaveValue("GitHub");
  await expect(page.getByPlaceholder("https://example.com/mcp")).toHaveValue(
    "https://mcp.example.test/mcp",
  );
  await expect(page.locator("select")).toHaveValue("bearer");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.getByRole("button", { name: "Add Treg", exact: true }).click();
  await page.getByPlaceholder("Treg token").fill("fake-treg-browser-credential");
  await page.getByRole("button", { name: "Verify and add", exact: true }).click();
  await expect(page.getByText(/MCP · https:\/\/treg\.to\/mcp\/ · credential saved/)).toBeVisible();

  await page.getByRole("button", { name: "Add MCP server", exact: true }).click();
  await page.getByPlaceholder("Display name").fill("Browser MCP");
  await page.getByPlaceholder("https://example.com/mcp").fill("https://mcp.example.test/mcp");
  await page.getByRole("button", { name: "Verify and add", exact: true }).click();
  await expect(page.getByText(/MCP · https:\/\/mcp\.example\.test\/mcp · no auth/)).toBeVisible();

  await page.getByRole("button", { name: "Add OpenAPI", exact: true }).click();
  await page.getByPlaceholder("Display name").fill("Browser API");
  await page
    .getByPlaceholder("https://example.com/openapi.json")
    .fill("https://api.example.test/openapi.json");
  await page.locator("select").selectOption("bearer");
  await page.getByPlaceholder("Credential").fill("fake-openapi-browser-credential");
  await page.getByRole("button", { name: "Verify and add", exact: true }).click();
  await expect(
    page.getByText(/API · https:\/\/api\.example\.test\/v1 · credential saved/),
  ).toBeVisible();

  await page.getByRole("button", { name: "Add Executor", exact: true }).click();
  await expect(page.getByPlaceholder("Display name")).toHaveValue("Executor");
  await page
    .getByPlaceholder("https://executor.example/mcp")
    .fill("https://executor.example.test/mcp");
  await page.getByPlaceholder("Executor token").fill("fake-executor-browser-credential");
  await page.getByRole("button", { name: "Verify and add", exact: true }).click();
  await expect(
    page.getByText(/MCP · https:\/\/executor\.example\.test\/mcp · credential saved/),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "11d-provider-emulators");

  await page.getByRole("button", { name: "Close integrations" }).click();
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
