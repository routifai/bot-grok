import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);

// Vitest cannot start a TypeScript worker, so the real worker script runs under tsx, the way the
// API itself runs (`tsx src/index.ts`): the pool spawns render-worker.ts and draws a fixture.
it("draws a chart through the real render-worker.ts under tsx", async () => {
  const { stdout } = await run(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("./pool-smoke.ts", import.meta.url))],
    { cwd: fileURLToPath(new URL("../../..", import.meta.url)), timeout: 60_000 },
  );
  const result = JSON.parse(stdout) as {
    mimeType: string;
    head: number[];
    size: number;
    width: number;
    height: number;
  };
  expect(result.mimeType).toBe("image/png");
  expect(result.head).toEqual([0x89, 0x50, 0x4e, 0x47]);
  expect(result.size).toBeGreaterThan(5000);
  expect([result.width, result.height]).toEqual([640, 424]);
}, 90_000);
