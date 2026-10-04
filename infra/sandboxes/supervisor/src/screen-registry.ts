import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ScreenAssignment } from "./supervisor-logic.js";

/**
 * Screen assignments (display index and view token per screen) live in the supervisor's
 * memory. Persisting them lets a restarted supervisor adopt the running desktops instead of
 * resetting every display and rotating the view token, which cut off open screens and closed
 * the Muse's browser mid-task.
 */
const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const SAFE_TOKEN = /^[a-zA-Z0-9_-]{1,64}$/;

function registryFile(dataDir: string, computerId: string) {
  if (!SAFE_ID.test(computerId)) return null;
  return path.join(dataDir, "computer-screens", `${computerId}.json`);
}

export async function saveScreenRegistry(
  dataDir: string,
  computerId: string,
  assigned: Map<string, ScreenAssignment>,
) {
  const file = registryFile(dataDir, computerId);
  if (!file) return;
  const entries = [...assigned.entries()]
    .filter(([, slot]) => !slot.releasing && slot.viewToken)
    .map(([screenKey, slot]) => ({
      screenKey,
      index: slot.index,
      leaseId: slot.leaseId,
      viewToken: slot.viewToken,
    }));
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const next = `${file}.${process.pid}.tmp`;
    await writeFile(next, JSON.stringify(entries), { mode: 0o600 });
    await rename(next, file);
  } catch {
    // Best effort: without a file the next supervisor start falls back to a full reset.
  }
}

export async function loadScreenRegistry(
  dataDir: string,
  computerId: string,
): Promise<Map<string, ScreenAssignment>> {
  const restored = new Map<string, ScreenAssignment>();
  const file = registryFile(dataDir, computerId);
  if (!file) return restored;
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(parsed)) return new Map();
    for (const entry of parsed) {
      if (
        !entry ||
        typeof entry.screenKey !== "string" ||
        !Number.isInteger(entry.index) ||
        entry.index < 0 ||
        typeof entry.viewToken !== "string" ||
        !SAFE_TOKEN.test(entry.viewToken)
      )
        return new Map();
      restored.set(entry.screenKey, {
        index: entry.index,
        viewToken: entry.viewToken,
        ...(typeof entry.leaseId === "string" ? { leaseId: entry.leaseId } : {}),
      });
    }
  } catch {
    return new Map();
  }
  return restored;
}

export async function forgetScreenRegistry(dataDir: string, computerId: string) {
  const file = registryFile(dataDir, computerId);
  if (file) await rm(file, { force: true }).catch(() => undefined);
}
