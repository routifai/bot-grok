import type { ThreadMessage } from "@aiden/contracts";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useId, useState } from "react";

/** The engine sends a failure's code, never its wording: the copy is ours. */
export function useFailureNoteText(): (code: string) => string {
  const { t } = useLingui();
  return (code) => {
    switch (code) {
      case "provider_unavailable":
        return t`I lost the connection. Try again.`;
      case "timeout":
        return t`That took too long. Try again.`;
      case "rate_limited":
      case "overloaded":
        return t`The model is busy. Try again in a moment.`;
      case "insufficient_credit":
        return t`The model account is out of credit.`;
      case "auth_failed":
        return t`The model refused my key.`;
      case "context_too_long":
        return t`This conversation is too long for the model.`;
      case "sandbox_unavailable":
        return t`My computer restarted. Try again.`;
      default:
        return t`Something went wrong on my side. Try again.`;
    }
  };
}

const ROW = "flex min-h-7 items-center gap-1.5 text-[12.5px] leading-[1.4] text-ink-3";

function FailureIcon() {
  return <CircleAlert size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />;
}

/** One failed reply as a quiet inline row on Nova's side: a small mark and the note. */
export function FailureNote({ children }: { children: ReactNode }) {
  return (
    <div className={ROW}>
      <FailureIcon />
      <p data-testid="message-error-note" className="min-w-0">
        {children}
      </p>
    </div>
  );
}

function clockTime(iso: string, locale: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString(locale || "en", { hour: "numeric", minute: "2-digit" });
}

/**
 * Several failed replies in a row (transcript `failures` rows, failureNotes.ts) as one line:
 * "3 failed attempts", and a small toggle that lists each note with its time.
 */
export function FailureRun({ messages }: { messages: readonly ThreadMessage[] }) {
  const { t, i18n } = useLingui();
  const noteText = useFailureNoteText();
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <div data-testid="failure-run" className="flex flex-col">
      <div className={ROW}>
        <FailureIcon />
        <span className="min-w-0 truncate">
          {plural(messages.length, { one: "# failed attempt", other: "# failed attempts" })}
        </span>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((value) => !value)}
          className="rounded-md px-1 py-0.5 text-[12.5px] text-link transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {open ? t`Hide` : t`Show`}
        </button>
      </div>
      {open ? (
        <ul
          id={listId}
          className="ms-[7px] mt-1 flex flex-col gap-1 border-s border-line ps-[15px]"
        >
          {messages.map((message) => (
            <li
              key={message.id}
              className="flex items-baseline justify-between gap-4 text-[13px] text-ink-2"
            >
              <span data-testid="message-error-note" className="min-w-0">
                {message.blocks.map((block) =>
                  block.kind === "error" ? noteText(block.code) : null,
                )}
              </span>
              <time
                dateTime={message.createdAt}
                className="shrink-0 font-mono text-[11.5px] tabular-nums text-ink-3"
              >
                {clockTime(message.createdAt, i18n.locale)}
              </time>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
