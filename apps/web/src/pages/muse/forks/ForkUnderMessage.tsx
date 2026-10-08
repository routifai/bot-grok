import type { MessageFork, ThreadMessage } from "@aiden/contracts";
import { cn, Popover, PopoverContent, PopoverTrigger } from "@aiden/ui-web";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Check } from "lucide-react";
import { useState } from "react";
import { FORK_TONE_CLASS, forkTone, forkUnder, messageForkStatus } from "./forkModel";
import { BranchIcon, forkTime, LiveDot, ReplyCurve } from "./forkParts";

const replies = (count: number) => plural(count, { one: "# reply", other: "# replies" });

/**
 * What hangs under a message (ADR 0010): each added fork's summary as a green-check line, then
 * one fork as an iMessage-style reply line, or several as one pill that fans out into a list.
 * Renders nothing for a message without forks.
 */
export function ForkUnderMessage({
  message,
  onOpenFork,
  onNewFork,
}: {
  message: ThreadMessage;
  onOpenFork: (fork: MessageFork, anchor: ThreadMessage) => void;
  /** Starts another fork from this message; absent where it cannot be forked. */
  onNewFork?: (anchor: ThreadMessage) => void;
}) {
  const summaries = message.blocks.flatMap((block) =>
    block.kind === "fork_summary" ? [block] : [],
  );
  const under = forkUnder(message.forks);
  if (!summaries.length && under.kind === "none") return null;
  const open = (chatId: string) => {
    const fork = message.forks?.find((item) => item.chatId === chatId);
    if (fork) onOpenFork(fork, message);
  };
  return (
    <div
      data-testid="fork-under"
      className={cn(
        "mt-1.5 flex flex-col gap-1.5",
        message.role === "user" ? "items-end" : "items-start",
      )}
    >
      {summaries.map((block) => (
        <button
          key={block.forkId}
          type="button"
          data-testid="fork-summary"
          onClick={() => open(block.forkId)}
          className="flex max-w-[560px] items-start gap-2 rounded-xl bg-selection px-3 py-2 text-start text-[13.5px] leading-[1.5] text-ink-2 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Check
            size={14}
            strokeWidth={2}
            aria-hidden="true"
            className="mt-[3px] shrink-0 text-success"
          />
          <span dir="auto">
            <Trans>From a fork:</Trans>{" "}
            <span className="font-medium text-foreground">{block.summary}</span>
          </span>
        </button>
      ))}
      {under.kind === "stub" ? (
        <button
          type="button"
          data-testid="fork-stub"
          onClick={() => onOpenFork(under.fork, message)}
          className="inline-flex max-w-full items-center gap-2 rounded-full py-1 ps-1 pe-3 text-[13px] text-ink-2 transition-colors hover:bg-selection focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ReplyCurve tone={under.tone} />
          <span
            className={cn(
              "min-w-0 truncate font-semibold",
              under.tone === "done" ? "text-ink-2" : FORK_TONE_CLASS[under.tone].text,
            )}
            dir="auto"
          >
            {under.fork.title}
          </span>
          <span className="shrink-0 text-ink-3">· {replies(under.fork.replies)}</span>
          {under.status === "live" ? <LiveDot tone={under.tone} /> : null}
        </button>
      ) : under.kind === "pill" ? (
        <ForkPill message={message} under={under} onOpen={open} onNewFork={onNewFork} />
      ) : null}
    </div>
  );
}

function ForkPill({
  message,
  under,
  onOpen,
  onNewFork,
}: {
  message: ThreadMessage;
  under: Extract<ReturnType<typeof forkUnder>, { kind: "pill" }>;
  onOpen: (chatId: string) => void;
  onNewFork?: (anchor: ThreadMessage) => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const forks = message.forks ?? [];
  const now = new Date();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        data-testid="fork-pill"
        className="inline-flex items-center gap-2.5 rounded-full py-[5px] ps-1 pe-3 text-[13px] text-ink-2 transition-colors hover:bg-selection focus-visible:outline-2 focus-visible:outline-ring data-[popup-open]:bg-selection"
      >
        <ReplyCurve tone="done" />
        <span aria-hidden="true" className="inline-flex">
          {under.pips.map((pip, index) => (
            <i
              key={pip.chatId}
              className={cn(
                "size-[18px] rounded-full border-2 border-card",
                index > 0 && "-ms-[7px]",
                FORK_TONE_CLASS[pip.tone].bg,
              )}
            />
          ))}
        </span>
        {under.more > 0 ? (
          <span className="text-[11px] font-semibold text-ink-2">+{under.more}</span>
        ) : null}
        <span>
          <span className="font-semibold text-foreground">
            {plural(under.total, { one: "# fork", other: "# forks" })}
          </span>{" "}
          · {under.open ? t`${under.open} open` : replies(under.replies)}
        </span>
        {under.live ? <LiveDot tone={under.pips[0]?.tone} /> : null}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={t`Forks`}
        className="w-[min(400px,calc(100vw-2rem))] gap-0 rounded-2xl border border-line bg-card p-1.5 shadow-float ring-0"
      >
        {forks.map((fork) => {
          const status = messageForkStatus(fork);
          const tone = forkTone({ chatId: fork.chatId, status });
          return (
            <button
              key={fork.chatId}
              type="button"
              onClick={() => {
                setOpen(false);
                onOpen(fork.chatId);
              }}
              className="grid w-full grid-cols-[4px_minmax(0,1fr)_auto] items-center gap-x-3 rounded-xl p-2.5 text-start transition-colors hover:bg-selection focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span
                aria-hidden="true"
                className={cn("h-[34px] w-1 rounded", FORK_TONE_CLASS[tone].bg)}
              />
              <span className="min-w-0">
                <span
                  className={cn(
                    "block truncate text-[13.5px] font-semibold",
                    status === "added" || status === "archived" ? "text-ink-2" : "text-foreground",
                  )}
                  dir="auto"
                >
                  {fork.title}
                </span>
                {fork.summary ? (
                  <span className="block truncate text-[12.5px] text-ink-3" dir="auto">
                    {fork.summary}
                  </span>
                ) : null}
              </span>
              <span className="flex items-center gap-2 font-mono text-[11.5px] tabular-nums text-ink-3">
                {fork.replies} · {forkTime(fork.createdAt, now)}
                {status === "live" ? <LiveDot tone={tone} /> : null}
              </span>
            </button>
          );
        })}
        {onNewFork ? (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onNewFork(message);
            }}
            className="mt-1 flex w-full items-center gap-2 border-t border-line p-2.5 text-[13px] font-medium text-foreground transition-colors hover:bg-selection focus-visible:outline-2 focus-visible:outline-ring"
          >
            <BranchIcon />
            <Trans>New fork from this message</Trans>
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
