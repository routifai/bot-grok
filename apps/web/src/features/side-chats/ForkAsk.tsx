import { Trans, useLingui } from "@lingui/react/macro";
import {
  type ChatSummary,
  FORK_ANCHOR_INVALID,
  FORK_TOO_DEEP,
  type ThreadMessage,
} from "@nova/contracts";
import { Button } from "@nova/ui-web";
import { useRef, useState } from "react";
import { ForkComposer } from "./ForkComposer";
import { ForkOverlay, type ForkWire, LiftedMessage, OverlayTopBar } from "./ForkOverlay";
import { BranchIcon } from "./forkParts";
import { type SendFailure, SendFailureNote } from "./SideChatSession";

const errorCode = (error: unknown) =>
  error && typeof error === "object" && "code" in error ? String(error.code) : null;

/**
 * "Lift and ask" (ADR 0010): the Conversation blurs, the message lifts, and one question box
 * sits under it. Sending opens the fork with that message as its anchor and hands it to the
 * thread view. Where a fork cannot go deeper, the same question can start a plain Side Chat.
 */
export function ForkAsk({
  botId,
  wire,
  anchor,
  chatId,
  onClose,
  onCreated,
  onOpenSideChat,
}: {
  botId: string;
  wire: ForkWire;
  anchor: ThreadMessage;
  /** The chat holding the anchor; null for the Conversation. */
  chatId: string | null;
  onClose: () => void;
  onCreated: (chat: ChatSummary, text: string) => void;
  onOpenSideChat: (chat: ChatSummary) => void;
}) {
  const { t } = useLingui();
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<SendFailure | null>(null);
  /** The question that could not be a fork of a fork: it can open as a side chat instead. */
  const [tooDeep, setTooDeep] = useState<string | null>(null);
  /** The engine refused this message as an anchor: asking again cannot help. */
  const [cannotFork, setCannotFork] = useState(false);
  const backRef = useRef<HTMLButtonElement>(null);

  const ask = async (text: string) => {
    setSending(true);
    setFailure(null);
    setCannotFork(false);
    try {
      const created = await wire.createFork({
        botId,
        ...(chatId ? { chatId } : {}),
        anchorItemId: anchor.id,
        text,
      });
      onCreated(created, text);
      return true;
    } catch (error) {
      if (errorCode(error) === FORK_TOO_DEEP) setTooDeep(text);
      else if (errorCode(error) === FORK_ANCHOR_INVALID) setCannotFork(true);
      else setFailure({ text, stage: "failed" });
      return false;
    } finally {
      setSending(false);
    }
  };

  const openSideChat = async (text: string) => {
    setSending(true);
    try {
      onOpenSideChat(await wire.createSide({ botId, start: "withContext", text }));
    } catch {
      setFailure({ text, stage: "failed" });
    } finally {
      setSending(false);
    }
  };

  return (
    <ForkOverlay label={t`Fork`} onClose={onClose}>
      <div className="mx-auto flex min-h-full max-w-[660px] flex-col gap-4 px-3 pt-4 pb-7 sm:px-6 sm:pt-[22px]">
        <OverlayTopBar onClose={onClose} backRef={backRef} />
        <LiftedMessage message={anchor} />
        <div className="flex flex-col gap-2.5 animate-[forkRise_300ms_cubic-bezier(.2,.8,.2,1)_60ms_both] motion-reduce:animate-none sm:ps-[52px]">
          <ForkComposer
            tone={null}
            autoFocus
            leading={<BranchIcon size={16} />}
            placeholder={t`Ask about this message`}
            sending={sending}
            onSend={ask}
          />
          {tooDeep ? (
            <div role="status" className="flex justify-end">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={sending}
                onClick={() => void openSideChat(tooDeep)}
              >
                <Trans>Open as side chat</Trans>
              </Button>
            </div>
          ) : null}
          {cannotFork ? (
            <p role="status" className="px-1 text-end text-[13px] text-muted-foreground">
              <Trans>
                This message can’t be forked. Pick another message, or ask in a side chat.
              </Trans>
            </p>
          ) : null}
          {failure ? (
            <SendFailureNote failure={failure} onRetry={() => void ask(failure.text)} />
          ) : null}
        </div>
      </div>
    </ForkOverlay>
  );
}
