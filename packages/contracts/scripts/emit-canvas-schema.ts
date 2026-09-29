import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod";
import { CanvasNodeSchema } from "../src/canvas.js";

/**
 * Nova Canvas's component catalog (packages/contracts/src/canvas.ts) is the single source
 * of truth; the Omnigent (Python) `show_canvas` tool reuses this generated JSON Schema as
 * its own inputSchema instead of hand-duplicating the catalog. Run via `pnpm --filter
 * @aiden/contracts run emit-canvas-schema`; re-run after any catalog change.
 */
const schema = z.toJSONSchema(CanvasNodeSchema, { target: "draft-7", io: "input" });

const outPath = fileURLToPath(
  new URL("../../../engine/omnigent/omnigent/nova/canvas/canvas.schema.json", import.meta.url),
);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(schema, null, 2)}\n`);
console.log(`Wrote ${outPath}`);
