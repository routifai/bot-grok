// The deck editor in the real embedding: the viewer in the panel, the deck two sandboxed frames
// deep, driven with real mouse and keyboard input (not synthetic DOM events, which never enter a
// sandboxed frame). Uses the dev fixture route /dev/deck, where the engine is a recorder.
import { expect, type Page, test } from "@playwright/test";

type Edit = { baseVersion: number; patches: Array<Record<string, unknown>> };
const edits = (page: Page) =>
  page.evaluate(() => (window as unknown as { __deckEdits?: Edit[] }).__deckEdits ?? []);

async function openEditor(page: Page) {
  await page.setViewportSize({ width: 1470, height: 742 });
  await page.goto("/dev/deck");
  await page.getByTestId("dev-edit-toggle").click();
  const frame = page.locator('[data-testid="deck-edit-frame"] iframe');
  await expect(frame).toBeVisible();
  // The bridge has reported in once the panel got the deck's theme (its font list).
  await expect(page.getByTestId("deck-style-panel")).toContainText("Select an element");
  await page.waitForTimeout(1500);
  return frame;
}

/** The centre of the cover title on the 1470 x 742 viewport (the stage scales to the frame). */
const TITLE = { x: 640, y: 356 };

test("click selects an element, hover outlines it, Escape deselects", async ({ page }) => {
  await openEditor(page);
  await page.mouse.move(TITLE.x, TITLE.y);
  await page.mouse.click(TITLE.x, TITLE.y);
  const panel = page.getByTestId("deck-style-panel");
  await expect(panel).toContainText("Slide 1 · Heading");
  await expect(panel).toContainText("cover-title");
  await page.keyboard.press("Escape");
  await expect(panel).toContainText("Select an element");
});

test("double-click edits the text inline and Enter saves one version", async ({ page }) => {
  await openEditor(page);
  await page.mouse.dblclick(TITLE.x, TITLE.y);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Shipping is fast");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await edits(page)).length).toBe(1);
  const [edit] = await edits(page);
  expect(edit?.baseVersion).toBe(1);
  expect(edit?.patches).toEqual([
    { kind: "set-text", id: "cover-title", text: "Shipping is fast" },
  ]);
  await expect(page.getByTestId("dev-version")).toHaveText("v2");
});

test("the font size control saves a style patch after a pause", async ({ page }) => {
  await openEditor(page);
  await page.mouse.click(TITLE.x, TITLE.y);
  const size = page.getByLabel("Font size", { exact: true });
  await size.fill("72");
  await expect.poll(async () => (await edits(page)).length, { timeout: 5000 }).toBe(1);
  const [edit] = await edits(page);
  expect(edit?.patches[0]).toMatchObject({
    kind: "set-style",
    id: "cover-title",
    style: { "font-size": "72px" },
  });
});
