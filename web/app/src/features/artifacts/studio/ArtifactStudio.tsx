import { useLingui } from "@lingui/react/macro";
import type { ArtifactVersion } from "@superchat/contracts";
import { Button, cn } from "@superchat/ui-web";
import { ChevronLeft, CornerDownRight, History, Pencil } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ShowMessageProvider, useShowMessage } from "../../../lib/show-message";
import type { AskDraft } from "../ask/AskBox";
import type { ArtifactContent } from "../editor/ArtifactEditor";
import { ArtifactEditor } from "../editor/ArtifactEditor";
import { artifactKey, setArtifactEditing } from "../editor/editor-state";
import { useArtifactContent } from "../library/useArtifactContent";
import { useArtifactPanelParts } from "../registry";
import type { StudioRow } from "./thread";
import { studioThread, threadSummary, versionOrigin } from "./thread";
import { usePhoneLayout } from "./usePhoneLayout";
import type { StudioChat } from "./useStudioChat";
import { useStudioChat } from "./useStudioChat";

/** How long a message picked from the version menu stays marked. */
const HIGHLIGHT_MS = 2200;

/** The file card the person last used: the studio hands focus back to it when it closes (ADR
 * 0024 "Web"). The panel between them does not know which card opened it, so the document
 * remembers the last card focused or pressed. */
let lastFileCard: HTMLElement | null = null;
const FILE_CARD = '[data-testid="media-tile"]';
function noteFileCard(event: Event) {
  const card =
    event.target instanceof Element ? event.target.closest<HTMLElement>(FILE_CARD) : null;
  if (card) lastFileCard = card;
}
if (typeof document !== "undefined") {
  document.addEventListener("focusin", noteFileCard, true);
  document.addEventListener("pointerdown", noteFileCard, true);
}

/** Escape belongs to the studio only when nothing else wants it: no open menu, no dialog opened
 * over it (inside it, or portalled after it), and nothing selected on the canvas (the element
 * chip in the ask box). A dialog under the studio (a phone's panel sheet) does not count. */
function studioOwnsEscape(root: HTMLElement | null): boolean {
  if (!root) return false;
  if (document.querySelector('[role="menu"]')) return false;
  for (const dialog of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
    if (dialog === root) continue;
    if (root.compareDocumentPosition(dialog) & Node.DOCUMENT_POSITION_FOLLOWING) return false;
  }
  return !root.querySelector('[data-testid="ask-chip"]');
}

/**
 * A file's studio (ADR 0024): the file in the editor that exists (navigator, canvas, inspector)
 * over the whole window, with the file's own chat beside it. Requests go to the file's studio
 * session, never to the Conversation; the thread is that session's transcript merged with the
 * file's versions. "‹ Super Chat" (and Escape with nothing selected) closes it.
 */
export function ArtifactStudio({
  artifactId,
  title,
  draft,
  onClose,
}: {
  /** Any version of the file. */
  artifactId: string;
  title?: string;
  /** Typed in the panel's ask box before the studio opened. */
  draft?: AskDraft;
  onClose: () => void;
}) {
  const content = useArtifactContent(artifactId);
  const ready = content.status === "ready" ? content : null;
  const chat = useStudioChat({
    artifactId,
    botId: ready?.artifact.botId ?? null,
    groupId: ready?.artifact.groupId ?? null,
    onSaved: content.refresh,
  });
  return <StudioView content={content} chat={chat} title={title} draft={draft} onClose={onClose} />;
}

/** The studio from its file and its chat (the dev page hands it fixtures). */
export function StudioView({
  content,
  chat,
  title,
  draft,
  onClose,
}: {
  content: ArtifactContent;
  chat: StudioChat;
  title?: string;
  draft?: AskDraft;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const ready = content.status === "ready" ? content : null;
  const panel = useArtifactPanelParts({
    artifact: ready?.artifact,
    title,
    bytes: ready?.bytes,
    newestVersion: content.versions[0] ?? null,
  });
  const sheet = useRef<HTMLElement>(null);
  const phone = usePhoneLayout();
  // On a phone the chat is a sheet over the canvas, opened from its composer.
  const [chatOpen, setChatOpen] = useState(false);
  const chatOpenRef = useRef(chatOpen);
  chatOpenRef.current = chatOpen;

  // The canvas is in edit mode for as long as the studio is open.
  const fileKey = ready ? artifactKey(ready.artifact) : null;
  useEffect(() => {
    if (!fileKey) return;
    setArtifactEditing(fileKey, true);
    return () => setArtifactEditing(fileKey, false);
  }, [fileKey]);

  // Escape closes the chat sheet, then the studio. Whether the studio owns the key is read before
  // anything handles it (a menu closing on the same key would otherwise look already gone), and
  // a handler inside that takes the key (defaultPrevented) still wins.
  useEffect(() => {
    let owned = false;
    const onCapture = (event: KeyboardEvent) => {
      if (event.key === "Escape") owned = studioOwnsEscape(sheet.current);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !owned || event.defaultPrevented) return;
      owned = false;
      event.preventDefault();
      if (chatOpenRef.current) setChatOpen(false);
      else onClose();
    };
    window.addEventListener("keydown", onCapture, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onCapture, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Focus goes back to the file card when the studio closes, else to whatever opened it.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const card = lastFileCard?.isConnected
        ? lastFileCard.querySelector<HTMLElement>("button, a[href]")
        : null;
      (card ?? (opener?.isConnected ? opener : null))?.focus({ preventScroll: true });
    };
  }, []);

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

  const origins: Record<ReturnType<typeof versionOrigin>, string> = {
    chat: t`From this chat`,
    superchat: t`From Super Chat`,
    you: t`By you`,
    restored: t`Restored`,
    updated: t`Updated from source`,
  };
  const versionLabel = (version: ArtifactVersion) =>
    origins[versionOrigin(version, chat.sessionId)];

  const rows = useMemo(
    () => studioThread(chat.messages, content.versions, chat.sessionId),
    [chat.messages, content.versions, chat.sessionId],
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
          locked: chat.running,
          versionOrigin: versionLabel,
          draft,
          waiting: chat.blockedOn,
          aside: (askBox) => (
            <StudioChatColumn
              rows={rows}
              highlight={highlight}
              askBox={askBox}
              sheet={phone ? { open: chatOpen, setOpen: setChatOpen } : null}
            />
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

  return createPortal(
    <ShowMessageProvider value={showMessage}>
      <div className="fixed inset-0 z-60" data-testid="artifact-studio">
        <div
          aria-hidden="true"
          data-testid="studio-scrim"
          onClick={onClose}
          className="absolute inset-0 bg-black/30 backdrop-blur-[3px] motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300"
        />
        <section
          ref={sheet}
          role="dialog"
          aria-modal="true"
          aria-label={title || ready?.artifact.name || t`Artifact`}
          data-layout={phone ? "phone" : "wide"}
          className="sc-studio absolute inset-0 flex min-h-0 flex-col overflow-hidden bg-background md:inset-3.5 md:rounded-[14px] md:shadow-float md:ring-[0.5px] md:ring-glass-line motion-safe:origin-[85%_40%] motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-75 motion-safe:duration-300"
        >
          {body}
        </section>
      </div>
    </ShowMessageProvider>,
    document.body,
  );
}

/**
 * "This file's chat": the merged thread, then the editor's own ask box. On a phone (`sheet`) it
 * is the composer under the canvas until the composer is used, then a sheet over the canvas with
 * the thread, closed by its back control or Escape. The ask box stays mounted either way, so
 * what is typed survives the sheet opening and closing.
 */
function StudioChatColumn({
  rows,
  highlight,
  askBox,
  sheet,
}: {
  rows: readonly StudioRow[];
  highlight: string | null;
  askBox: ReactNode;
  sheet: { open: boolean; setOpen: (open: boolean) => void } | null;
}) {
  const { t } = useLingui();
  const summary = threadSummary(rows);
  const list = useRef<HTMLDivElement>(null);
  const count = rows.length;
  const threadShown = !sheet || sheet.open;
  // Newest at the bottom, as a chat reads; a picked version's message is brought into view.
  useEffect(() => {
    const element = list.current;
    if (!element || count === 0 || !threadShown) return;
    element.scrollTop = element.scrollHeight;
  }, [count, threadShown]);
  useEffect(() => {
    if (!highlight) return;
    list.current
      ?.querySelector(`[data-row-id="${CSS.escape(highlight)}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlight]);
  return (
    <aside
      data-testid="studio-chat"
      data-state={sheet ? (sheet.open ? "open" : "closed") : undefined}
      aria-label={t`This file's chat`}
      onFocus={sheet && !sheet.open ? () => sheet.setOpen(true) : undefined}
      className={cn(
        "flex shrink-0 flex-col bg-content",
        !sheet && "w-[340px] border-s border-border",
        sheet && "order-3 w-full border-t border-border",
        sheet?.open &&
          "absolute inset-x-0 bottom-0 z-30 max-h-[85%] rounded-t-[14px] shadow-float motion-safe:animate-in motion-safe:slide-in-from-bottom-6 motion-safe:duration-200",
      )}
    >
      {threadShown ? (
        <StudioChatThread
          list={list}
          rows={rows}
          highlight={highlight}
          summary={summary}
          onBack={sheet ? () => sheet.setOpen(false) : null}
        />
      ) : null}
      <div className="px-3 pt-1 pb-3">{askBox}</div>
    </aside>
  );
}

function StudioChatThread({
  list,
  rows,
  highlight,
  summary,
  onBack,
}: {
  list: RefObject<HTMLDivElement | null>;
  rows: readonly StudioRow[];
  highlight: string | null;
  summary: ReturnType<typeof threadSummary>;
  /** The phone sheet's back control. */
  onBack: (() => void) | null;
}) {
  const { t } = useLingui();
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
  const { t } = useLingui();
  if (row.kind === "me") {
    return (
      <div
        data-row-id={row.id}
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
  }
  if (row.kind === "ai") {
    return (
      <p
        data-testid="studio-reply"
        dir="auto"
        className="m-0 text-[13.5px] leading-normal whitespace-pre-wrap text-foreground"
      >
        {row.text}
      </p>
    );
  }
  if (row.kind === "note") {
    return (
      <div
        data-testid="studio-note"
        className="flex items-start gap-[7px] text-[12px] leading-[1.4] text-ink-2"
      >
        <History size={13} aria-hidden="true" className="mt-px shrink-0" />
        <span dir="auto">{row.text}</span>
      </div>
    );
  }
  if (row.kind === "hand") {
    return (
      <div
        data-testid="studio-hand-edit"
        className="flex items-start gap-[7px] text-[12px] leading-[1.4] text-ink-2"
      >
        <Pencil size={13} aria-hidden="true" className="mt-px shrink-0" />
        <span dir="auto">
          {row.count > 1
            ? t`You changed ${row.element} · ${row.count} edits · v${row.from} → v${row.to}`
            : row.summary || t`Edited by hand`}
        </span>
      </div>
    );
  }
  const day = new Date(row.at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const label =
    row.origin === "chat"
      ? t`saved`
      : row.origin === "you"
        ? t`saved by you`
        : row.origin === "restored"
          ? t`restored`
          : row.origin === "updated"
            ? t`updated from source`
            : row.version === 1
              ? t`made in Super Chat · ${day}`
              : t`from Super Chat`;
  return (
    <div data-testid="studio-version" className="flex items-center gap-2 text-[11px] text-ink-3">
      <span aria-hidden="true" className="h-px flex-1 bg-separator" />
      <span className="rounded-[4px] border border-border bg-content px-[5px] font-mono text-[10.5px] text-foreground">
        v{row.version}
      </span>
      <span>{label}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-separator" />
    </div>
  );
}
