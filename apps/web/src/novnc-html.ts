import type { Readable } from "node:stream";

export const MAX_NOVNC_HTML_BYTES = 1024 * 1024;

/** Read a noVNC document with a hard cap, and fail if the upstream ends without `end`. */
export function collectNovncHtml(incoming: Readable, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      incoming.destroy();
      reject(error);
    };
    incoming.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBytes) {
        fail(new Error(`noVNC document exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(buf);
    });
    incoming.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    incoming.on("error", (error: unknown) => {
      fail(error instanceof Error ? error : new Error("noVNC upstream failed"));
    });
    incoming.on("aborted", () => {
      fail(new Error("noVNC upstream aborted"));
    });
    incoming.on("close", () => {
      if (!settled) fail(new Error("noVNC upstream closed"));
    });
  });
}

/** Message the embedded desktop posts to the app when its connection drops. */
export const SCREEN_DISCONNECTED_MESSAGE = "nova:screen-disconnected";

const RFB_CREATED = /const rfb = new RFB\([^;]*\);/;

/**
 * Lets the app recover a black screen on its own: after the embed creates its noVNC
 * connection, report disconnects to the parent so it can fetch a fresh screen link.
 * Leaves documents without that connection line untouched.
 */
export function injectScreenLifecycle(html: string): string {
  return html.replace(
    RFB_CREATED,
    (created) =>
      `${created}\n      rfb.addEventListener("disconnect", () => window.parent.postMessage({ type: ${JSON.stringify(SCREEN_DISCONNECTED_MESSAGE)} }, "*"));`,
  );
}
