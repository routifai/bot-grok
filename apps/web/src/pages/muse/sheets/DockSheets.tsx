import { Trans, useLingui } from "@lingui/react/macro";
import { MessageSquare, Plus, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { WaitingSheet } from "../../../features/approvals";
import { LibraryScreen } from "../../../features/artifacts/LibraryScreen";
import { AutomationsSheet } from "../../../features/automations";
import { FilesTab } from "../../../features/computer/FilesTab";
import { rpc } from "../../../lib/rpc";
import type { DockKey } from "../chrome/Dock";
import { DockSheet, DockSheetHeader } from "../chrome/DockSheet";
import { readFileAsBase64 } from "../conversation/shared";
import { PRIMARY_BUTTON, QUIET_BUTTON, SegmentedControl } from "../ui";

type FilesView = "workspace" | "made";

function MiniAppsSheet({
  botId,
  botName,
  open,
  onClose,
  onNewApp,
  onSendIdea,
}: {
  botId: string;
  botName: string;
  open: boolean;
  onClose: () => void;
  onNewApp: () => void;
  onSendIdea: (text: string) => void;
}) {
  const { t } = useLingui();
  return (
    <DockSheet open={open} title={t`Mini Apps`} onClose={onClose}>
      <DockSheetHeader title={t`Mini Apps`} subtitle={t`Small apps I built for you.`} />
      {open ? (
        <div className="rk-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
          <LibraryScreen
            embedded
            mode="apps"
            botId={botId}
            botName={botName}
            onSendIdea={onSendIdea}
            toolbarAction={
              <button type="button" className={PRIMARY_BUTTON} onClick={onNewApp}>
                <Plus size={16} aria-hidden="true" className="me-1.5" />
                <Trans>New app</Trans>
              </button>
            }
          />
        </div>
      ) : null}
    </DockSheet>
  );
}

function FilesSheet({
  botId,
  botName,
  open,
  onClose,
  refreshKey,
  reveal,
  onChatWithFolder,
  onSendIdea,
}: {
  botId: string;
  botName: string;
  open: boolean;
  onClose: () => void;
  refreshKey: number;
  reveal: { path: string; nonce: number } | null;
  /** Opens a side chat working in `folder` (workspace-relative; `""` is the whole workspace). */
  onChatWithFolder: (folder: string) => void;
  onSendIdea: (text: string) => void;
}) {
  const { t } = useLingui();
  const [view, setView] = useState<FilesView>("workspace");
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
      <DockSheetHeader title={t`Files`} subtitle={t`Your workspace, and what I made for you.`}>
        <SegmentedControl
          label={t`Files view`}
          className="shrink-0 [&>button]:flex-none"
          value={view}
          onChange={setView}
          options={[
            { value: "workspace", label: t`Workspace` },
            { value: "made", label: t`Made for you` },
          ]}
        />
      </DockSheetHeader>
      {open && view === "workspace" ? (
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
      {open && view === "made" ? (
        <div className="rk-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
          <LibraryScreen embedded botId={botId} botName={botName} onSendIdea={onSendIdea} />
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
  botName,
  sheet,
  onClose,
  filesRefreshKey,
  filesReveal,
  onStartChat,
  onOpenFolderChat,
}: {
  botId: string;
  botName: string;
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
      <MiniAppsSheet
        botId={botId}
        botName={botName}
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
        botName={botName}
        open={sheet === "files"}
        onClose={onClose}
        refreshKey={filesRefreshKey}
        reveal={filesReveal}
        onChatWithFolder={(folder) => {
          onClose();
          onOpenFolderChat(folder);
        }}
        onSendIdea={sendAndClose}
      />
    </>
  );
}
