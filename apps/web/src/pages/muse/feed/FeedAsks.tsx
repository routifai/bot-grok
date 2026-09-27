import { Trans, useLingui } from "@lingui/react/macro";
import type { Ask } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
import { useState } from "react";

// Minimal, self-contained pinned-Ask item for the Feed. Another agent is building the
// shared Ask item + `useAsks` hook under `apps/web/src/pages/muse/asks/`; swap this out
// for that once it lands (it wasn't present in this worktree). `AskCard.tsx` renders a
// `ThreadMessage` "ask" block (actions/purpose/credential/status), which doesn't match the
// flattened `Ask` view type here (choices/input/kind), so this is a purpose-built card
// instead of a reuse of `AskCard`.

function AskKindLabel({ kind }: { kind: Ask["kind"] }) {
  if (kind === "proposal") return <Trans>Proposal</Trans>;
  if (kind === "blocked_task") return <Trans>Blocked task</Trans>;
  if (kind === "approval") return <Trans>Approval</Trans>;
  return <Trans>Question</Trans>;
}

function FeedAskCard({
  ask,
  onAnswer,
}: {
  ask: Ask;
  onAnswer: (ask: Ask, answer: string) => Promise<void>;
}) {
  const { t } = useLingui();
  const [value, setValue] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitting = pending !== null;

  async function submit(answer: string) {
    if (submitting || !answer.trim()) return;
    setPending(answer);
    setError(null);
    try {
      await onAnswer(ask, answer);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not submit this answer`);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-card px-5 py-4">
      <div className="flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
        <span>
          <AskKindLabel kind={ask.kind} />
        </span>
        {ask.goalTitle ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="truncate">{ask.goalTitle}</span>
          </>
        ) : null}
      </div>
      <div className="mt-1.5 text-[15px] leading-[1.5] text-foreground">{ask.text}</div>
      {ask.detail ? (
        <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted px-3.5 py-3 font-mono text-[12.5px] leading-[1.7] text-muted-foreground">
          {ask.detail}
        </pre>
      ) : null}
      {ask.choices.length > 0 ? (
        <div className="mt-3.5 flex flex-wrap gap-2">
          {ask.choices.map((choice) => (
            <Button
              key={choice.id}
              variant="outline"
              size="sm"
              disabled={submitting}
              onClick={() => void submit(choice.id)}
            >
              {pending === choice.id ? <Trans>Sending…</Trans> : choice.label}
            </Button>
          ))}
        </div>
      ) : ask.input ? (
        <form
          className="mt-3.5 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(value);
          }}
        >
          <Input
            aria-label={t`Answer`}
            type={ask.input === "secret" ? "password" : "text"}
            autoComplete="off"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={t`Type your answer`}
          />
          <Button type="submit" size="sm" disabled={!value.trim() || submitting}>
            {submitting ? <Trans>Sending…</Trans> : <Trans>Send</Trans>}
          </Button>
        </form>
      ) : null}
      {error ? <p className="mt-2 text-[12.5px] text-destructive">{error}</p> : null}
    </div>
  );
}

export function FeedAsks({
  asks,
  onAnswer,
}: {
  asks: Ask[];
  onAnswer: (ask: Ask, answer: string) => Promise<void>;
}) {
  if (asks.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {asks.map((ask) => (
        <FeedAskCard key={ask.id} ask={ask} onAnswer={onAnswer} />
      ))}
    </div>
  );
}
