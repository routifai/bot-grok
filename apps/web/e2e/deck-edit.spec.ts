// The deck editor in the real embedding: the viewer in the panel, the deck two sandboxed frames
// deep, driven with real mouse and keyboard input (not synthetic DOM events, which never enter a
// sandboxed frame). Uses the dev fixture route /dev/deck, where the engine is a recorder.
import { expect, type Page, test } from "@playwright/test";

type Edit = { baseVersion: number; patches: Array<Record<string, unknown>> };
const edits = (page: Page) =>
  page.evaluate(() => (window as unknown as { __deckEdits?: Edit[] }).__deckEdits ?? []);

const SHOTS = process.env.DECK_SHOTS;
async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function openEditor(page: Page) {
  await page.setViewportSize({ width: 1470, height: 742 });
  await page.goto("/dev/deck");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const frame = page.locator('[data-testid="deck-edit-frame"] iframe');
  await expect(frame).toBeVisible();
  // The bridge has reported in once the panel got the deck's theme (its font list).
  await page.waitForTimeout(1500);
  return frame;
}

/** The cover title, found on the visible edit frame (the stage scales to the frame). */
async function titlePoint(page: Page) {
  const box = await page.locator('[data-testid="deck-edit-frame"] iframe').boundingBox();
  if (!box) throw new Error("no edit frame");
  return { x: box.x + box.width * TITLE_AT.x, y: box.y + box.height * TITLE_AT.y };
}
// The cover title's middle as a fraction of the edit frame, whose slide is letterboxed in the
// widened panel.
const TITLE_AT = { x: 0.41, y: 0.42 };
const panelWidth = async (page: Page) =>
  (await page.getByTestId("dev-panel").boundingBox())?.width ?? 0;

const panel = (page: Page) => page.getByTestId("deck-style-panel");
const frameBox = (page: Page) =>
  page.locator('[data-testid="deck-edit-frame"] iframe').boundingBox();

test("edit widens the panel and leaving it restores the width and the full rail", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1470, height: 742 });
  await page.goto("/dev/deck");
  const rail = page.getByTestId("deck-rail");
  await expect(rail).toBeVisible();
  const before = await panelWidth(page);
  const railBefore = (await rail.boundingBox())?.width ?? 0;
  await shot(page, "view");

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect.poll(() => panelWidth(page)).toBeGreaterThan(before + 200);
  await expect(rail).toHaveAttribute("data-slim", "true");
  await expect
    .poll(async () => (await rail.boundingBox())?.width ?? 999)
    .toBeLessThan(railBefore / 2);
  // No empty-state text and no inspector until something is selected.
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByText("Select an element")).toHaveCount(0);
  await expect(page.getByTestId("deck-style-empty")).toContainText("Click an element to edit it.");
  await page.waitForTimeout(1500);
  await shot(page, "edit");

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect.poll(() => panelWidth(page)).toBe(before);
  await expect(rail).not.toHaveAttribute("data-slim", "true");
  await expect.poll(async () => (await rail.boundingBox())?.width).toBe(railBefore);
});

test("the slim rail expands on hover and on its toggle without moving the slide", async ({
  page,
}) => {
  await openEditor(page);
  const rail = page.getByTestId("deck-rail");
  const stageBefore = await frameBox(page);
  await expect(rail).not.toHaveAttribute("data-open", "true");

  await rail.hover();
  await expect(rail).toHaveAttribute("data-open", "true");
  await expect.poll(async () => (await rail.boundingBox())?.width).toBeGreaterThan(130);
  expect(await frameBox(page)).toEqual(stageBefore);
  await shot(page, "edit-rail-open");

  await page.mouse.move(700, 400);
  await expect(rail).not.toHaveAttribute("data-open", "true");

  await page.getByRole("button", { name: "Expand slides" }).click();
  await page.mouse.move(700, 400);
  await expect(rail).toHaveAttribute("data-open", "true");
  // Picking a slide from the open rail goes there.
  await rail.getByRole("option").nth(1).click();
  await expect(page.getByTestId("deck-counter")).toHaveText(/^2 \//);
  await page.getByRole("button", { name: "Collapse slides" }).click();
  await expect(rail).not.toHaveAttribute("data-open", "true");
});

test("the inspector appears only on a selection and closes with Escape or its button", async ({
  page,
}) => {
  await openEditor(page);
  await expect(panel(page)).toHaveCount(0);
  const stageBefore = await frameBox(page);

  const title = await titlePoint(page);
  await page.mouse.move(title.x, title.y);
  await page.mouse.click(title.x, title.y);
  await expect(panel(page)).toContainText("Slide 1 · Heading");
  await expect(panel(page)).toContainText("cover-title");
  // The inspector column was reserved for the whole session: the stage did not reflow, and
  // nothing sits under the inspector.
  expect(await frameBox(page)).toEqual(stageBefore);
  const stageAfter = await frameBox(page);
  const inspector = await panel(page).boundingBox();
  expect((stageAfter?.x ?? 0) + (stageAfter?.width ?? 0)).toBeLessThanOrEqual(
    (inspector?.x ?? 0) + 1,
  );
  await shot(page, "edit-selected");

  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);

  await page.mouse.click(title.x, title.y);
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole("button", { name: "Close" }).click();
  await expect(panel(page)).toHaveCount(0);
});

test("double-click edits the text inline and Enter saves one version", async ({ page }) => {
  await openEditor(page);
  const title = await titlePoint(page);
  await page.mouse.dblclick(title.x, title.y);
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
  const title = await titlePoint(page);
  await page.mouse.click(title.x, title.y);
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

test("the Theme gallery opens from the header, picking a theme sends one set-theme patch", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1470, height: 742 });
  const themes = [
    ["corporate-clean", "Corporate Clean", "professional", "light"],
    ["nord", "Nord", "dark", "dark"],
  ].map(([id, name, category, mode]) => ({
    id,
    name,
    mood: `${name} mood`,
    category,
    mode,
    bestFor: "",
    preview: "",
  }));
  await page.exposeFunction("__deckThemes", () => ({ themes, defaultTheme: "corporate-clean" }));
  await page.exposeFunction("__deckTheme", () => "corporate-clean");
  await page.goto("/dev/deck");
  await page.getByRole("button", { name: "Theme", exact: true }).click();
  const gallery = page.getByTestId("deck-theme-picker");
  await expect(gallery.getByRole("radio")).toHaveCount(2);
  await expect(gallery).toContainText("Nord mood");
  await shot(page, "theme-gallery");
  // the keyboard lands on a card, the arrows move between them, Escape gives focus back
  await expect(gallery.getByTestId("deck-theme-corporate-clean")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(gallery.getByTestId("deck-theme-nord")).toBeFocused();
  await gallery.getByTestId("deck-theme-nord").click();
  await expect.poll(async () => (await edits(page)).length).toBe(1);
  expect((await edits(page))[0]?.patches).toEqual([{ kind: "set-theme", theme: "nord" }]);
  await expect(page.getByTestId("dev-version")).toHaveText("v2");
  await page.keyboard.press("Escape");
  await expect(gallery).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Theme", exact: true })).toBeFocused();
});
