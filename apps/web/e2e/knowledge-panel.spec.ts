import { readFile } from "node:fs/promises";
import type { MemoryDocument } from "@aiden/contracts";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

// The bot-scoped Knowledge panel (per-bot memory + skill editor, reached through the old
// bot-settings side panel) has no reachable UI in Nova: the trigger only rendered in the
// pre-Muse header, which is now dead code (Shell.tsx always runs museMode). Skills are
// managed from the Library screen instead (a different, demonstration-driven UI with no
// manual create/edit form), so this spec now covers only the still-reachable space-wide
// shared memory documents in Settings -> Memory.
test("space-wide shared memory documents are readable, editable, and exportable", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const userName = `Knowledge ${stamp}`;
  await signup(page, `knowledge-${stamp}@aiden.test`, "password12", userName);
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  await openUserSettings(page, "memory");
  await expect(page.getByLabel("Close memory settings")).toBeVisible();
  const spaceDocs = page.getByTestId("space-memory-documents");
  await expect(spaceDocs.getByText("Shared documents")).toBeVisible();
  const memoryRow = spaceDocs.getByRole("button", { name: /MEMORY\.md/ });
  await expect(memoryRow).toBeVisible();
  await memoryRow.click();
  const docEditor = spaceDocs.locator("textarea");
  const marker = `Edited in e2e ${stamp}`;
  await docEditor.fill(`# Memory\n\n${marker}\n`);
  await captureScreenshot(page, testInfo, "83-space-memory-editor");
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route(
    "**/rpc/memory/update",
    async (route) => {
      await saveGate;
      await route.continue();
    },
    { times: 1 },
  );
  await spaceDocs.getByRole("button", { name: "Save", exact: true }).click();
  try {
    await expect(docEditor).toBeDisabled();
    await expect(memoryRow).toBeDisabled();
    await expect(spaceDocs.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  } finally {
    releaseSave();
  }
  await expect(spaceDocs.getByText("rev 2")).toBeVisible();

  // The save persisted: reopen the document and find the marker.
  await memoryRow.click();
  await expect(docEditor).toHaveValue(new RegExp(marker));
  await captureScreenshot(page, testInfo, "84-space-memory-saved");
  const sharedDocuments = await rpc<MemoryDocument[]>(page, "memory/list", { scope: "user" });
  expect(sharedDocuments).toContainEqual(
    expect.objectContaining({ content: `# Memory\n\n${marker}\n`, revision: 2 }),
  );
  // Export must fetch fresh content.
  const sharedDocument = sharedDocuments.find((doc) => doc.path === "MEMORY.md")!;
  const latestMarker = `Latest shared memory ${stamp}`;
  await rpc(page, "memory/update", { documentId: sharedDocument.id, content: latestMarker });
  const downloadPromise = page.waitForEvent("download");
  await spaceDocs.getByRole("button", { name: "Download as markdown" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("space-memory.md");
  const exported = await readFile((await download.path())!, "utf8");
  expect(exported).toContain(latestMarker);
  expect(exported).not.toContain(marker);
  await page.getByLabel("Close memory settings").click();
  await expect(page.getByLabel("Close memory settings")).toHaveCount(0);
});
