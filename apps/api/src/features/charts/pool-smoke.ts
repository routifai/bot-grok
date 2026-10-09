// Run under tsx by pool.real.test.ts: draws one fixture through the real worker script.
import { CHART_FIXTURES } from "@nova/charts";
import { RenderPool } from "./pool.js";

const pool = new RenderPool({
  workerUrl: new URL("./render-worker.ts", import.meta.url),
  size: 1,
  timeoutMs: 20_000,
});
try {
  const fixture = CHART_FIXTURES.find((f) => f.id === "dual-axis") ?? CHART_FIXTURES[0];
  if (!fixture) throw new Error("no fixtures");
  const image = await pool.render({
    document: fixture,
    options: { width: 640, height: 400, theme: "dark", format: "png" },
  });
  process.stdout.write(
    JSON.stringify({
      mimeType: image.mimeType,
      head: [...image.bytes.subarray(0, 4)],
      size: image.bytes.length,
      width: image.width,
      height: image.height,
    }),
  );
} finally {
  await pool.close();
}
