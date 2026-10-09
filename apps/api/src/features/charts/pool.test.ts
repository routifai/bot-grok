import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ThumbnailCache } from "./cache.js";
import { RenderBusyError, type RenderJob, RenderPool, RenderTimeoutError } from "./pool.js";

const JOB = {
  document: { spec: {}, data: [] },
  options: { width: 100, height: 100, theme: "light", format: "png" },
} as unknown as RenderJob;

/** A stand-in worker: replies after `job.document.data.length`-independent delay set per script. */
function script(body: string): URL {
  const dir = mkdtempSync(join(tmpdir(), "pool-"));
  const file = join(dir, "worker.mjs");
  writeFileSync(
    file,
    `import { parentPort } from "node:worker_threads";
parentPort.on("message", ({ id, job }) => { ${body} });`,
  );
  return pathToFileURL(file);
}

const OK = `parentPort.postMessage({ id, ok: true, mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]), width: 1, height: 1 });`;

let pool: RenderPool | undefined;
afterEach(async () => {
  await pool?.close();
  pool = undefined;
});

describe("RenderPool", () => {
  it("returns what the worker drew", async () => {
    pool = new RenderPool({ workerUrl: script(OK), size: 1 });
    const image = await pool.render(JOB);
    expect([...image.bytes]).toEqual([1, 2, 3]);
    expect(image.mimeType).toBe("image/png");
  });

  it("keeps the event loop free while a job is busy", async () => {
    pool = new RenderPool({
      workerUrl: script(`const end = Date.now() + 400; while (Date.now() < end) {} ${OK}`),
      size: 1,
    });
    const running = pool.render(JOB);
    // The main thread must keep ticking while the worker spins.
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 20);
    await running;
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(8);
  });

  it("kills a render past its deadline and recovers", async () => {
    const hang = script("while (true) {}");
    pool = new RenderPool({ workerUrl: hang, size: 1, timeoutMs: 150 });
    await expect(pool.render(JOB)).rejects.toBeInstanceOf(RenderTimeoutError);
    // The slot was dropped; a later job gets a fresh worker (which hangs again, proving it spawned).
    await expect(pool.render(JOB)).rejects.toBeInstanceOf(RenderTimeoutError);
  });

  it("surfaces a worker error as a rejection", async () => {
    pool = new RenderPool({
      workerUrl: script(`parentPort.postMessage({ id, ok: false, message: "boom" });`),
      size: 1,
    });
    await expect(pool.render(JOB)).rejects.toThrow("boom");
  });

  it("refuses work beyond the queue limit instead of growing", async () => {
    pool = new RenderPool({
      workerUrl: script(`setTimeout(() => { ${OK} }, 100);`),
      size: 1,
      maxQueue: 1,
    });
    const first = pool.render(JOB); // runs
    const second = pool.render(JOB); // queued
    await expect(pool.render(JOB)).rejects.toBeInstanceOf(RenderBusyError);
    await Promise.all([first, second]);
  });
});

describe("ThumbnailCache", () => {
  const entry = (n: number) => ({ contentBase64: "x".repeat(n) });
  const sizeOf = (value: { contentBase64: string }) => value.contentBase64.length;

  it("evicts the least recently used past the entry limit", () => {
    const cache = new ThumbnailCache(sizeOf, 2, 1000);
    cache.set("a", entry(1));
    cache.set("b", entry(1));
    cache.get("a");
    cache.set("c", entry(1));
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
  });

  it("evicts past the size budget, counted by what is stored, but keeps the newest entry", () => {
    const cache = new ThumbnailCache(sizeOf, 10, 100);
    cache.set("a", entry(60));
    cache.set("b", entry(60));
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    expect(cache.bytes).toBe(60);
    cache.set("huge", entry(500));
    expect(cache.get("huge")).toBeDefined();
  });
});
