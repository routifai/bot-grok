import { parseAttachmentReferences, WORKSPACE_UPLOADS_PREFIX } from "@superchat/core";
import { bytesToBase64 } from "./base64.js";
import type { OmnigentClientConfig } from "./client.js";
import { readOmnigentFile, WORKSPACE_FILE_MAX_BYTES } from "./client.js";

/**
 * The images a turn refers to, read back from the Computer so the model sees them: every
 * `image/*` attachment line under `your_files/uploads/` (<= 5 MiB each). Best effort: a file
 * that cannot be read stays a path line in the text.
 */
export async function readTurnImages(
  client: OmnigentClientConfig,
  email: string,
  sessionId: string,
  turnInput: string,
): Promise<Array<{ mimeType: string; dataBase64: string }>> {
  const images: Array<{ mimeType: string; dataBase64: string }> = [];
  const seen = new Set<string>();
  for (const line of turnInput.split("\n")) {
    const { attachments } = parseAttachmentReferences(line);
    for (const ref of attachments) {
      if (!ref.mimeType.startsWith("image/") || ref.size > WORKSPACE_FILE_MAX_BYTES) continue;
      if (!ref.path.startsWith(WORKSPACE_UPLOADS_PREFIX) || seen.has(ref.path)) continue;
      seen.add(ref.path);
      try {
        const file = await readOmnigentFile(client, email, sessionId, ref.path);
        if (
          file.truncated ||
          file.bytes.length === 0 ||
          file.bytes.length > WORKSPACE_FILE_MAX_BYTES
        ) {
          continue;
        }
        images.push({
          mimeType: ref.mimeType,
          dataBase64: bytesToBase64(file.bytes),
        });
      } catch (error) {
        console.error("omnigent: could not read an attached image back", error);
      }
    }
  }
  return images;
}
