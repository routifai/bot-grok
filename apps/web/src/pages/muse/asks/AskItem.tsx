import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { Ask } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
import { useState } from "react";

/**
 * Renders one open Ask: what the Muse is waiting on, where it came from, and
 * a way to answer it in place. Matches the look of `AskCard.tsx` (the
 * Conversation's own ask block), but reads the `Ask` view type (choices +
 * typed input) instead of a thread message block's approval/secret shape, so
 * it fits both the Conversation's asks and Goal-log asks the same way.
 */
export function AskItem({
  ask,
  onAnswer,
  onOpenSource,
}: {
  ask: Ask;
  onAnswer: (value: string) => Promise<void>;
  /** Called when the person taps the "from" label; omit to leave it inert. */
  onOpenSource?: () => void;
}) {
  const { t } = useLingui();
  const [text, setText] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitting = pending !== null;
  const sourceLabel = ask.goalTitle ?? t`Conversation`;

  async function submit(value: string) {
    if (submitting) return;
    const trimmed = ask.input === "secret" ? value : value.trim();
    if (ask.input === "secret" ? trimmed.length === 0 : !trimmed) return;
    setPending(ask.input ? "text-answer" : trimmed);
    setError(null);
    try {
      await onAnswer(trimmed);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not submit this answer`);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-card px-5 py-4">
      {onOpenSource ? (
        <button
          type="button"
          onClick={onOpenSource}
          className="text-[12.5px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {sourceLabel}
        </button>
      ) : (
        <span className="text-[12.5px] font-medium text-muted-foreground">{sourceLabel}</span>
      )}
      <div className="mt-1.5 text-[15.5px] leading-[1.5] text-foreground">
        <ChatMarkdown>{ask.text}</ChatMarkdown>
      </div>
      {ask.detail ? (
        <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted px-3.5 py-3 font-mono text-[12.5px] leading-[1.7] text-muted-foreground">
          {ask.detail}
        </pre>
      ) : null}
      {ask.input ? (
        <form
          className="mt-3.5 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(text);
          }}
        >
          <Input
            aria-label={t`Answer`}
            type={ask.input === "secret" ? "password" : "text"}
            autoComplete="off"
            spellCheck={ask.input !== "secret"}
            disabled={submitting}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t`Type your answer`}
          />
          <Button type="submit" className="self-start" disabled={!text.trim() || submitting}>
            {submitting ? <Trans>Sending…</Trans> : <Trans>Send</Trans>}
          </Button>
        </form>
      ) : (
        <div className="mt-3.5 flex flex-wrap gap-1.5">
          {ask.choices.map((choice) => (
            <Button
              key={choice.id}
              variant="outline"
              className="h-auto justify-start whitespace-normal px-3.5 py-2.5 text-start font-normal"
              disabled={submitting}
              onClick={() => void submit(choice.id)}
            >
              {pending === choice.id ? <Trans>Sending…</Trans> : choice.label}
            </Button>
          ))}
        </div>
      )}
      {error ? <p className="mt-3 text-[13px] text-destructive">{error}</p> : null}
    </div>
  );
}
