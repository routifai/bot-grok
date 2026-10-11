import { Trans, useLingui } from "@lingui/react/macro";
import { MessageSquare, Plus, Upload } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { WaitingSheet } from "../../../features/approvals";
import { LibraryScreen } from "../../../features/artifacts/LibraryScreen";
import { LibraryArtifactView } from "../../../features/artifacts/library/LibraryArtifactView";
import { AutomationsSheet } from "../../../features/automations";
import { FilesTab } from "../../../features/computer/FilesTab";
import { rpc } from "../../../lib/rpc";
import type { DockKey } from "../chrome/Dock";
import { DockSheet, DockSheetHeader } from "../chrome/DockSheet";
import { readFileAsBase64 } from "../conversation/shared";
import { QUIET_BUTTON } from "../ui";

export function LibrarySheet({
  botId,
  open,
  onClose,
  onNewApp,
  onSendIdea,
}: {
  botId: string;
  open: boolean;
  onClose: () => void;
  onNewApp: () => void;
  onSendIdea: (text: string) => void;
}) {
  const { t } = useLingui();
  // A file opened from the grid replaces it in the same sheet; the grid stays mounted underneath
  // (hidden), so its filter and search survive, and its scroll position is put back.
  const [openId, setOpenId] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const scrollTop = useRef(0);
  const holdsEscape = useRef(false);
  const openFile = useCallback((id: string) => {
    scrollTop.current = scroller.current?.scrollTop ?? 0;
    holdsEscape.current = false;
    setOpenId(id);
  }, []);
  useLayoutEffect(() => {
    if (openId === null && scroller.current) scroller.current.scrollTop = scrollTop.current;
  }, [openId]);
  // The sheet closing by any route (another dock place) leaves the grid for next time.
  useLayoutEffect(() => {
    if (!open) setOpenId(null);
  }, [open]);
  const close = () => {
    setOpenId(null);
    onClose();
  };
  return (
    <DockSheet
      open={open}
      title={t`Library`}
      onClose={close}
      bare={openId !== null}
      // Escape inside a file goes back to the grid first; the next one closes the sheet.
      onEscape={() => {
        if (openId === null) return false;
        if (!holdsEscape.current) setOpenId(null);
        return true;
      }}
    >
      <div className={openId ? "hidden" : "contents"}>
        <DockSheetHeader title={t`Library`} subtitle={t`Apps, decks and documents I made for you.`}>
          <button type="button" className={QUIET_BUTTON} onClick={onNewApp}>
            <Plus size={15} strokeWidth={2} aria-hidden="true" className="me-1 -ms-0.5" />
            <Trans>New app</Trans>
          </button>
        </DockSheetHeader>
        {open ? (
          <div
            ref={scroller}
            className="rk-scroll -mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto px-1"
          >
            <LibraryScreen botId={botId} onSendIdea={onSendIdea} onOpenArtifact={openFile} />
          </div>
        ) : null}
      </div>
      {open && openId ? (
        <LibraryArtifactView
          artifactId={openId}
          onBack={() => setOpenId(null)}
          onClose={close}
          onHoldsEscape={(holds) => {
            holdsEscape.current = holds;
          }}
        />
      ) : null}
    </DockSheet>
  );
}

function FilesSheet({
  botId,
  open,
  onClose,
  refreshKey,
  reveal,
  onChatWithFolder,
}: {
  botId: string;
  open: boolean;
  onClose: () => void;
  refreshKey: number;
  reveal: { path: string; nonce: number } | null;
  /** Opens a side chat working in `folder` (workspace-relative; `""` is the whole workspace). */
  onChatWithFolder: (folder: string) => void;
}) {
  const { t } = useLingui();
  // The folder "Chat with" uses; none picked is the whole workspace.
  const [folder, setFolder] = useState<string | null>(null);
  const [uploads, setUploads] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setUploadError(null);
    try {
      for (const file of Array.from(files)) {
        await rpc.files.uploadAttachment({
          botId,
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          contentBase64: await readFileAsBase64(file),
        });
      }
      setUploads((count) => count + 1);
    } catch (cause) {
      setUploadError(cause instanceof Error ? cause.message : t`Could not upload this.`);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <DockSheet open={open} title={t`Files`} onClose={onClose}>
      <DockSheetHeader title={t`Files`} subtitle={t`Your workspace.`} />
      {open ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={input}
              type="file"
              multiple
              hidden
              data-testid="files-upload-input"
              onChange={(event) => void upload(event.target.files)}
            />
            <button
              type="button"
              className={QUIET_BUTTON}
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              <Upload size={15} aria-hidden="true" className="me-1.5" />
              {busy ? t`Uploading…` : t`Upload`}
            </button>
            <button
              type="button"
              className={QUIET_BUTTON}
              onClick={() => onChatWithFolder(folder ?? "")}
            >
              <MessageSquare size={15} aria-hidden="true" className="me-1.5" />
              {folder ? (
                <Trans>Chat with {folder.split("/").pop()}</Trans>
              ) : (
                <Trans>Chat with the workspace</Trans>
              )}
            </button>
            {uploadError ? (
              <span className="text-[13px] text-destructive">{uploadError}</span>
            ) : null}
          </div>
          <div className="rk-scroll min-h-0 flex-1 overflow-y-auto">
            <FilesTab
              botId={botId}
              refreshKey={refreshKey + uploads}
              reveal={reveal}
              selectedFolder={folder}
              onSelectFolder={(path) => setFolder((current) => (current === path ? null : path))}
            />
          </div>
        </div>
      ) : null}
    </DockSheet>
  );
}

/**
 * The four places the dock opens, each a large glass sheet over the dimmed home or the
 * Conversation. The Shell owns which one is open and what "start a chat" means.
 */
export function DockSheets({
  botId,
  sheet,
  onClose,
  filesRefreshKey,
  filesReveal,
  onStartChat,
  onOpenFolderChat,
}: {
  botId: string;
  sheet: DockKey | null;
  onClose: () => void;
  filesRefreshKey: number;
  filesReveal: { path: string; nonce: number } | null;
  /** Opens the Conversation; with `send` the text goes at once, with `seed` it waits in the composer. */
  onStartChat: (input: { send?: string; seed?: string }) => void;
  /** Opens a new side chat that works in this workspace folder. */
  onOpenFolderChat: (folder: string) => void;
}) {
  const sendAndClose = (text: string) => {
    onClose();
    onStartChat({ send: text });
  };
  return (
    <>
      <WaitingSheet
        botId={botId}
        open={sheet === "inbox"}
        onOpenChange={(open) => !open && onClose()}
      />
      <LibrarySheet
        botId={botId}
        open={sheet === "apps"}
        onClose={onClose}
        onNewApp={() => {
          onClose();
          onStartChat({ seed: "Build me an app that " });
        }}
        onSendIdea={sendAndClose}
      />
      <AutomationsSheet botId={botId} open={sheet === "automations"} onClose={onClose} />
      <FilesSheet
        botId={botId}
        open={sheet === "files"}
        onClose={onClose}
        refreshKey={filesRefreshKey}
        reveal={filesReveal}
        onChatWithFolder={(folder) => {
          onClose();
          onOpenFolderChat(folder);
        }}
      />
    </>
  );
}
