import { confineWorkspacePath, WorkspacePathError } from "@nova/adapters";
import { isAllowedAttachmentMimeType, type WorkspaceAttachment } from "@nova/contracts";
import { WORKSPACE_UPLOADS_PREFIX, type WorkspaceAttachmentRef } from "@nova/core";
import { ORPCError } from "@orpc/server";

// biome-ignore lint/suspicious/noControlCharactersInRegex: a reference line must stay on one line
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Checks the files a send refers to: each must be a confined path under `your_files/uploads/`
 * of an allowed type, so a crafted request cannot point the Muse at another part of the
 * workspace or smuggle extra lines into the turn text. */
export function validateWorkspaceAttachments(
  attachments: readonly WorkspaceAttachment[],
): WorkspaceAttachmentRef[] {
  return attachments.map((attachment) => {
    let path: string;
    try {
      path = confineWorkspacePath(attachment.path);
    } catch (error) {
      if (error instanceof WorkspacePathError) {
        throw new ORPCError("BAD_REQUEST", { message: error.message });
      }
      throw error;
    }
    if (
      path !== attachment.path ||
      !path.startsWith(WORKSPACE_UPLOADS_PREFIX) ||
      path.length === WORKSPACE_UPLOADS_PREFIX.length ||
      CONTROL.test(path)
    ) {
      throw new ORPCError("BAD_REQUEST", { message: "Attachment is not an uploaded file" });
    }
    if (!isAllowedAttachmentMimeType(attachment.mimeType)) {
      throw new ORPCError("BAD_REQUEST", {
        message: `Unsupported attachment type: ${attachment.mimeType}`,
      });
    }
    return { path, mimeType: attachment.mimeType, size: attachment.size };
  });
}
