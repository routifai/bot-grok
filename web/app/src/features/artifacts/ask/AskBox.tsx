import { useLingui } from "@lingui/react/macro";
import { Button, cn } from "@superchat/ui-web";
import { ArrowUp, Loader2, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AskStatus } from "./useArtifactAsk";

/** One selected part of the artifact, shown as a chip inside the box. */
export type AskChip = { id: string; label: string; detail?: string };

/** Words typed in one ask box, handed to another (the panel's box to the file's studio). */
export type AskDraft = { text: string; caret: number };

/**
 * The message box for asking superchat to change the artifact that is open: the selection as
 * chips, the person's words, send (or stop while superchat works), and one quiet status line
 * above it. Kind-agnostic: the kind supplies the chips and the request block (`useArtifactAsk`).
 */
export function AskBox({
  chips,
  onRemoveChip,
  placeholder,
  focusRequest,
  status,
  onSend,
  onStop,
  onUndo,
  canUndo,
  className,
  onHandOff,
  initialDraft,
  sendInitialDraft,
  onDraftChange,
  note,
}: {
  chips: readonly AskChip[];
  onRemoveChip?: (id: string) => void;
  placeholder: string;
  /** Bumped to focus the box (the toolbar's Ask, the selection chip's Ask). */
  focusRequest: number;
  status: AskStatus;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  onUndo?: () => void;
  canUndo?: boolean;
  className?: string;
  /** Sending hands the words to another box instead (the file's studio opens and sends them).
   * Typing stays here, so nothing typed is lost while the other box opens. */
  onHandOff?: (draft: AskDraft) => void;
  /** Words typed before this box opened: kept, focused, with the caret where it was. */
  initialDraft?: AskDraft;
  /** The words handed over were already sent by the person: send them as soon as this opens. */
  sendInitialDraft?: boolean;
  /** Every change to the words, so a box that closes can hand them to the next one. */
  onDraftChange?: (draft: AskDraft) => void;
  /** Why the request waits ("Finishing another file first"): the status line while it does. */
  note?: string | null;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(initialDraft?.text ?? "");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const handedOver = useRef(initialDraft);
  const sendOnOpen = useRef(sendInitialDraft);
  const handled = useRef(focusRequest);
  useEffect(() => {
    if (focusRequest === handled.current) return;
    handled.current = focusRequest;
    textarea.current?.focus();
  }, [focusRequest]);

  const working = status.kind === "sending" || status.kind === "editing";
  const send = async () => {
    const text = draft.trim();
    if (!text || working) return;
    if (onHandOff) {
      onHandOff({ text: draft, caret: draft.length });
      setDraft("");
      return;
    }
    setDraft("");
    onDraftChange?.({ text: "", caret: 0 });
    if (!(await onSend(text))) {
      setDraft(text);
      onDraftChange?.({ text, caret: text.length });
    }
  };
  // Words handed over: focused with the caret where it was, and sent when the person sent them.
  useEffect(() => {
    const given = handedOver.current;
    const box = textarea.current;
    if (!given || !box) return;
    box.focus();
    box.setSelectionRange(given.caret, given.caret);
    if (!sendOnOpen.current) return;
    sendOnOpen.current = false;
    void send();
  }, []);

  return (
    <div className={cn("flex w-full flex-col gap-2", className)} data-testid="ask-box">
      <AskStatusRow
        status={status}
        note={note}
        onStop={onStop}
        onUndo={canUndo ? onUndo : undefined}
      />
      <div className="sc-ask" data-state={working ? "editing" : status.kind}>
        <div className="sc-ask-body flex flex-col gap-2.5 py-3 ps-4 pe-3">
          {chips.length ? (
            <div className="flex flex-wrap gap-1.5">
              {chips.map((chip) => (
                <span
                  key={chip.id}
                  data-testid="ask-chip"
                  title={chip.detail}
                  className="inline-flex h-6 max-w-full items-center gap-1 rounded-[7px] bg-selection-strong ps-2 pe-1 text-[12px] text-tint-ink"
                >
                  <span className="truncate">{chip.label}</span>
                  {onRemoveChip ? (
                    <button
                      type="button"
                      aria-label={t`Remove ${chip.label}`}
                      onClick={() => onRemoveChip(chip.id)}
                      className="grid size-4 place-items-center rounded opacity-70 hover:opacity-100"
                    >
                      <X size={11} strokeWidth={2.2} />
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}
          <div className="flex items-end gap-3">
            <textarea
              ref={textarea}
              value={draft}
              onChange={(event) => {
                const { value, selectionStart } = event.target;
                setDraft(value);
                onDraftChange?.({ text: value, caret: selectionStart ?? value.length });
              }}
              onKeyDown={(event) => {
                const composing = event.nativeEvent.isComposing || event.keyCode === 229;
                if (event.key === "Enter" && !event.shiftKey && !composing) {
                  event.preventDefault();
                  void send();
                }
              }}
              rows={1}
              dir="auto"
              aria-label={t`Ask superchat`}
              placeholder={placeholder}
              className="max-h-32 min-h-[24px] flex-1 resize-none bg-transparent py-1 text-[15px] leading-[1.45] text-foreground outline-none [field-sizing:content] placeholder:text-muted-foreground"
            />
            {working ? (
              <Button
                size="icon"
                aria-label={t`Stop`}
                onClick={onStop}
                className="size-8 shrink-0 rounded-full"
              >
                <Square size={10} strokeWidth={0} fill="currentColor" />
              </Button>
            ) : (
              <Button
                size="icon"
                aria-label={t`Send`}
                disabled={!draft.trim()}
                onClick={() => void send()}
                className="size-8 shrink-0 rounded-full transition-transform active:scale-95"
              >
                <ArrowUp size={16} strokeWidth={2.2} />
              </Button>
            )}
          </div>
        </div>
      </div>
      <p className="truncate ps-1 text-[11px] text-muted-foreground" dir="auto">
        {working
          ? t`You asked: ${status.asked}`
          : chips.length
            ? t`Enter to send · Shift+Enter for a new line · superchat changes only what you selected`
            : t`Enter to send · Shift+Enter for a new line`}
      </p>
    </div>
  );
}

function AskStatusRow({
  status,
  note,
  onStop,
  onUndo,
}: {
  status: AskStatus;
  note?: string | null;
  onStop: () => void;
  onUndo?: () => void;
}) {
  const { t } = useLingui();
  const row = "flex h-[22px] items-center gap-2 ps-1 text-[12px] text-muted-foreground";
  const working = status.kind === "sending" || status.kind === "editing";
  if (working || note) {
    return (
      <div role="status" data-testid="ask-status" className={row}>
        <Loader2 size={12} className="animate-spin text-tint motion-reduce:animate-none" />
        <span className="truncate">{note || t`superchat is editing…`}</span>
        {working ? (
          <button
            type="button"
            onClick={onStop}
            className="ms-auto rounded-md border border-border px-2 py-0.5 text-foreground hover:bg-accent"
          >
            {t`Stop`}
          </button>
        ) : null}
      </div>
    );
  }
  if (status.kind === "idle") return <div aria-hidden="true" className="h-[22px]" />;
  if (status.kind === "updated") {
    return (
      <div role="status" data-testid="ask-status" className={row}>
        <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
        <span className="truncate">{t`Updated · version ${status.version}`}</span>
        {onUndo ? (
          <button
            type="button"
            onClick={onUndo}
            className="text-link underline-offset-2 hover:underline"
          >
            {t`Undo`}
          </button>
        ) : null}
      </div>
    );
  }
  if (status.kind === "replied") {
    return (
      <div role="status" data-testid="ask-status" className={row} title={status.reply}>
        <span className="truncate" dir="auto">
          {status.reply || t`No change was made.`}
        </span>
      </div>
    );
  }
  return (
    <div role="status" data-testid="ask-status" className={cn(row, "text-destructive")}>
      <span className="truncate">{status.message || t`Couldn't send that.`}</span>
    </div>
  );
}
