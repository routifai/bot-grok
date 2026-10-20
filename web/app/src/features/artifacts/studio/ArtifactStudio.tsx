import { useLingui } from "@lingui/react/macro";
import type { ArtifactVersion } from "@superchat/contracts";
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogTitle,
  Sheet,
  SheetContent,
  SheetTitle,
} from "@superchat/ui-web";
import { ChevronLeft, CornerDownRight, History, Pencil } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ShowMessageProvider, useShowMessage } from "../../../lib/show-message";
import { formatDayAndTime } from "../../activity/activityGrouping";
import type { AskDraft } from "../ask/AskBox";
import type { ArtifactContent } from "../editor/ArtifactEditor";
import { ArtifactEditor } from "../editor/ArtifactEditor";
import { artifactKey, setArtifactEditing } from "../editor/editor-state";
import { useArtifactContent } from "../library/useArtifactContent";
import { useArtifactPanelParts } from "../registry";
import type { StudioRow } from "./thread";
import { requestSlide, studioThread, threadSummary, versionOrigin } from "./thread";
import { useOriginLabel } from "./useOriginLabel";
import { usePhoneLayout } from "./usePhoneLayout";
import { useSeenVersion } from "./useSeenVersion";
import type { StudioChat } from "./useStudioChat";
import { useStudioChat } from "./useStudioChat";

/** How long a message picked from the version menu stays marked. */
const HIGHLIGHT_MS = 2200;

type StudioProps = {
  title?: string;
  /** Sent from the panel's ask box: the studio opens and sends it. */
  draft?: AskDraft;
  onClose: () => void;
  /** Where focus goes when the studio closes (the file card that opened the panel); the control
   * that opened the studio when it is gone or not given. */
  returnFocus?: HTMLElement | null;
};

/**
 * A file's studio (ADR 0024): the file in the editor that exists (navigator, canvas, inspector)
 * over the whole window, with the file's own chat beside it. Requests go to the file's studio
 * session, never to the Conversation; the thread is that session's transcript merged with the
 * file's versions. "‹ Super Chat" (and Escape with nothing selected) closes it.
 */
export function ArtifactStudio({
  artifactId,
  ...props
}: StudioProps & {
  /** Any version of the file. */
  artifactId: string;
}) {
  const content = useArtifactContent(artifactId);
  const ready = content.status === "ready" ? content : null;
  const chat = useStudioChat({
    artifactId,
    botId: ready?.artifact.botId ?? null,
    groupId: ready?.artifact.groupId ?? null,
    onSaved: content.refresh,
  });
  return <StudioView content={content} chat={chat} {...props} />;
}

/** The studio from its file and its chat (the dev page hands it fixtures). */
export function StudioView({
  content,
  chat,
  title,
  draft,
  onClose,
  returnFocus,
}: StudioProps & { content: ArtifactContent; chat: StudioChat }) {
  const { t } = useLingui();
  const ready = content.status === "ready" ? content : null;
  const panel = useArtifactPanelParts({
    artifact: ready?.artifact,
    title,
    bytes: ready?.bytes,
    newestVersion: content.versions[0] ?? null,
  });
  const phone = usePhoneLayout();
  // On a phone the chat is a sheet over the canvas; what is typed there outlives its closing.
  const [chatOpen, setChatOpen] = useState(!!draft);
  const typed = useRef<AskDraft | undefined>(draft);
  // The panel's request is sent once, by the first ask box to open; any change to the words after
  // that (the send clears them) is the person's own draft.
  const sendDraft = useRef(!!draft);
  const onDraftChange = useCallback((next: AskDraft) => {
    typed.current = next;
    sendDraft.current = false;
  }, []);
  // Escape leaves the studio only while nothing on the canvas is selected.
  const selected = useRef(false);
  const onSelectedChange = useCallback((on: boolean) => {
    selected.current = on;
  }, []);

  // The canvas is in edit mode for as long as the studio is open.
  const fileKey = ready ? artifactKey(ready.artifact) : null;
  useEffect(() => {
    if (!fileKey) return;
    setArtifactEditing(fileKey, true);
    return () => setArtifactEditing(fileKey, false);
  }, [fileKey]);

  // "Show in Super Chat" from the version menu leaves the studio first.
  const showInConversation = useShowMessage();
  const showMessage = useMemo(
    () =>
      showInConversation
        ? (itemId: string) => {
            onClose();
            showInConversation(itemId);
          }
        : null,
    [showInConversation, onClose],
  );

  const originLabel = useOriginLabel();
  const versionLabel = (version: ArtifactVersion) =>
    originLabel(versionOrigin(version, chat.sessionId));

  const seen = useSeenVersion(
    ready?.artifact.groupId ?? null,
    content.versions[0]?.version ?? null,
  );
  const rows = useMemo(
    () => studioThread(chat.messages, content.versions, chat.sessionId, seen),
    [chat.messages, content.versions, chat.sessionId, seen],
  );

  // A version of this chat picked from the menu marks the message that made it.
  const [highlight, setHighlight] = useState<string | null>(null);
  const shown = content.versions.find((version) => version.id === content.versionId);
  const pickedOlder = !!shown && shown.id !== content.versions[0]?.id;
  const picked = pickedOlder && shown?.fromStudio ? (shown.itemId ?? null) : null;
  useEffect(() => {
    if (!picked) return;
    setHighlight(picked);
    const timer = window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [picked]);

  const back = (
    <Button
      variant="ghost"
      size="sm"
      aria-label={t`Back to Super Chat`}
      data-testid="studio-back"
      className="-ms-2 me-1 shrink-0 text-muted-foreground"
      onClick={onClose}
    >
      <ChevronLeft />
      {t`Super Chat`}
    </Button>
  );

  const body =
    ready && chat.sessionId ? (
      <ArtifactEditor
        content={content}
        panel={panel}
        title={title}
        onClose={onClose}
        leading={back}
        studio={{
          chatId: chat.sessionId,
          turn: { running: chat.running, onSent: chat.sent },
          slide: requestSlide(rows),
          layout: phone ? "phone" : "wide",
          onSelectedChange,
          versionOrigin: versionLabel,
          draft: typed.current,
          sendDraft: sendDraft.current,
          onDraftChange,
          waiting: chat.blockedOn,
          aside: (askBox) =>
            phone ? (
              <PhoneChat
                rows={rows}
                highlight={highlight}
                askBox={askBox}
                open={chatOpen}
                onOpenChange={setChatOpen}
              />
            ) : (
              <aside
                data-testid="studio-chat"
                aria-label={t`This file's chat`}
                className="flex w-[340px] shrink-0 flex-col border-s border-border bg-content"
              >
                <StudioChatThread rows={rows} highlight={highlight} />
                <div className="px-3 pt-1 pb-3">{askBox}</div>
              </aside>
            ),
        }}
      />
    ) : (
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center border-b border-border px-4 py-2.5">
          {back}
        </header>
        <div
          className={cn(
            "grid flex-1 place-items-center text-[13.5px]",
            content.status === "error" || chat.failed
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {content.status === "error"
            ? content.message
            : chat.failed
              ? t`Could not load this.`
              : t`Loading…`}
        </div>
      </div>
    );

  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        // Escape is the canvas's while something is selected, and an overlay's of the file's own
        // (the Theme gallery) while it is open. Menus and the phone's chat sheet take it first
        // on their own, being dialogs and menus over this one.
        if (details.reason === "escape-key" && (selected.current || panel.holdsEscape)) {
          details.cancel();
          return;
        }
        onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        finalFocus={() => (returnFocus?.isConnected ? returnFocus : true)}
        data-testid="artifact-studio"
        data-layout={phone ? "phone" : "wide"}
        className={cn(
          "top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none bg-background p-0 text-foreground ring-0 sm:max-w-none",
          "md:top-3.5 md:left-3.5 md:h-[calc(100dvh-1.75rem)] md:w-[calc(100vw-1.75rem)] md:rounded-[14px] md:shadow-float md:ring-[0.5px] md:ring-glass-line",
        )}
      >
        <DialogTitle className="sr-only">
          {title || ready?.artifact.name || t`Artifact`}
        </DialogTitle>
        <ShowMessageProvider value={showMessage}>{body}</ShowMessageProvider>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A phone's chat: under the canvas, a control that reads as the composer; it opens the thread
 * and the ask box as a sheet over the canvas, closed by its back control or Escape.
 */
function PhoneChat({
  rows,
  highlight,
  askBox,
  open,
  onOpenChange,
}: {
  rows: readonly StudioRow[];
  highlight: string | null;
  askBox: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  return (
    <div data-testid="studio-chat" className="shrink-0 border-t border-border bg-content p-3">
      <Button
        variant="outline"
        data-testid="studio-chat-open"
        className="w-full justify-start rounded-full font-normal text-muted-foreground"
        onClick={() => onOpenChange(true)}
      >
        {t`Ask superchat to change this file…`}
      </Button>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          data-testid="studio-chat-sheet"
          className="h-[85dvh] gap-0 rounded-t-[14px] bg-content"
        >
          <SheetTitle className="sr-only">{t`This file's chat`}</SheetTitle>
          <StudioChatThread rows={rows} highlight={highlight} onBack={() => onOpenChange(false)} />
          <div className="px-3 pt-1 pb-3">{askBox}</div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function StudioChatThread({
  rows,
  highlight,
  onBack,
}: {
  rows: readonly StudioRow[];
  highlight: string | null;
  /** The phone sheet's back control. */
  onBack?: () => void;
}) {
  const { t } = useLingui();
  const summary = threadSummary(rows);
  const list = useRef<HTMLDivElement>(null);
  const count = rows.length;
  // Newest at the bottom, as a chat reads; a picked version's message is brought into view.
  useEffect(() => {
    const element = list.current;
    if (!element || count === 0) return;
    element.scrollTop = element.scrollHeight;
  }, [count]);
  return (
    <>
      <div className="flex items-center gap-2 px-4 pt-3 pb-2 text-[12px] text-ink-2">
        {onBack ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Back`}
            data-testid="studio-chat-back"
            className="-ms-2 text-muted-foreground"
            onClick={onBack}
          >
            <ChevronLeft />
          </Button>
        ) : null}
        <h3 className="text-[13px] font-semibold text-foreground">{t`This file's chat`}</h3>
        {summary ? (
          <span data-testid="studio-chat-summary">
            {summary.edits === 1
              ? t`1 edit · v${summary.first} to v${summary.last}`
              : t`${summary.edits} edits · v${summary.first} to v${summary.last}`}
          </span>
        ) : null}
      </div>
      <div
        ref={list}
        data-testid="studio-thread"
        className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 pt-1 pb-2"
      >
        {rows.map((row) => (
          <ThreadRow key={row.id} row={row} highlighted={highlight === row.id} />
        ))}
      </div>
    </>
  );
}

function ThreadRow({ row, highlighted }: { row: StudioRow; highlighted: boolean }) {
  const { t, i18n } = useLingui();
  const originLabel = useOriginLabel();
  const self = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlighted) self.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [highlighted]);
  switch (row.kind) {
    case "me":
      return (
        <div
          ref={self}
          data-testid="studio-request"
          className={cn(
            "max-w-[88%] self-end rounded-[14px] rounded-ee-[4px] bg-bubble px-[11px] py-[7px] text-[13.5px] leading-[1.4] text-foreground motion-safe:transition-shadow",
            highlighted && "ring-2 ring-tint",
          )}
        >
          {row.chip ? (
            <span className="mb-[3px] flex items-center gap-1 text-[11px] text-tint">
              <CornerDownRight size={11} aria-hidden="true" />
              {row.chip}
            </span>
          ) : null}
          <span className="whitespace-pre-wrap" dir="auto">
            {row.text}
          </span>
        </div>
      );
    case "ai":
      return (
        <p
          data-testid="studio-reply"
          dir="auto"
          className="m-0 text-[13.5px] leading-normal whitespace-pre-wrap text-foreground"
        >
          {row.text}
        </p>
      );
    case "note":
      return (
        <div
          data-testid="studio-note"
          className="flex items-start gap-[7px] text-[12px] leading-[1.4] text-ink-2"
        >
          <History size={13} aria-hidden="true" className="mt-px shrink-0" />
          <span>
            {row.notice === "queued"
              ? t`Finishing another file first`
              : row.origin === "update"
                ? t`A live update saved v${row.version ?? ""} while you were editing`
                : t`Super Chat saved v${row.version ?? ""} while you were editing`}
          </span>
        </div>
      );
    case "hand":
      return (
        <div
          data-testid="studio-hand-edit"
          className="flex items-start gap-[7px] text-[12px] leading-[1.4] text-ink-2"
        >
          <Pencil size={13} aria-hidden="true" className="mt-px shrink-0" />
          <span dir="auto">
            {row.count > 1
              ? t`You changed ${row.element} · ${row.count} edits · v${row.from} → v${row.to}`
              : row.what}
          </span>
        </div>
      );
    case "since":
      return (
        <div
          data-testid="studio-since"
          className="flex items-center gap-2 text-[11px] font-medium text-foreground"
        >
          <span>{t`Since you were here`}</span>
          <span aria-hidden="true" className="h-px flex-1 bg-border" />
        </div>
      );
    case "version":
      return (
        <div
          data-testid="studio-version"
          className="flex items-center gap-2 text-[11px] text-ink-3"
        >
          <span aria-hidden="true" className="h-px flex-1 bg-separator" />
          <span className="rounded-[4px] border border-border bg-content px-[5px] font-mono text-[10.5px] text-foreground">
            v{row.version}
          </span>
          <span>
            {originLabel(row.origin)} · {formatDayAndTime(row.createdAt, i18n.locale)}
          </span>
          <span aria-hidden="true" className="h-px flex-1 bg-separator" />
        </div>
      );
  }
}
