// Runs inside a worker thread (see pool.ts): draws one chart image so the API's event loop never does.
import { parentPort } from "node:worker_threads";
import type { RenderJob } from "./pool.js";
import { renderChart } from "./render.js";

type Message = { id: number; job: RenderJob };

parentPort?.on("message", ({ id, job }: Message) => {
  try {
    const image = renderChart(job.document, job.options);
    const bytes = new Uint8Array(image.bytes);
    parentPort?.postMessage(
      { id, ok: true, mimeType: image.mimeType, bytes, width: image.width, height: image.height },
      [bytes.buffer],
    );
  } catch (error) {
    parentPort?.postMessage({
      id,
      ok: false,
      message: error instanceof Error ? error.message : "render failed",
    });
  }
});
