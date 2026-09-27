import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { Ask } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
import { HelpCircle, ShieldCheck, Sparkles } from "lucide-react";
import { useState } from "react";
import { formatRelativeTime } from "../../../lib/relative-time";
import { DetailRows, Eyebrow, Surface } from "../ui";

const KIND_ICON = {
  approval: ShieldCheck,
  proposal: Sparkles,
  question: HelpCircle,
  blocked_task: HelpCircle,
} as const;

/**
 * Splits `Key: value` lines (an approval's To / Subject / Body headers) into rows for
 * `DetailRows`; null when the detail doesn't look like that shape, so it renders as quiet
 * text instead (docs/muse/DESIGN.md, "Waiting on you").
 */
function parseDetailRows(detail: string): { label: string; value: string }[] | null {
  const lines = detail.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;
  const rows: { label: string; value: string }[] = [];
  for (const line of lines) {
    const match = /^([A-Za-z][A-Za-z ]{0,20}):\s(.*)$/.exec(line);
    if (!match?.[1] || match[2] === undefined) return null;
    rows.push({ label: match[1], value: match[2] });
  }
  return rows;
}

/**
 * Renders one open Ask (docs/muse/DESIGN.md, "Waiting on you"): an icon and a
 * plain-language title in the Muse's voice, what it's waiting on — choices or a typed
 * answer — and where it came from. Shared by the Feed and the Waiting-on-you sheet, so an
 * Ask looks and answers the same everywhere (CONTEXT.md: answering anywhere closes it
 * everywhere). Matches the look of `AskCard.tsx` (the Conversation's own ask block), but
 * reads the `Ask` view type instead of a thread message block's shape.
 */
export function AskItem({
  ask,
  onAnswer,
  onOpenSource,
}: {
  ask: Ask;
  onAnswer: (value: string) => Promise<void>;
  /** Called when the person taps the source eyebrow; omit to leave it inert. */
  onOpenSource?: () => void;
}) {
  const { t } = useLingui();
  const [text, setText] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitting = pending !== null;

  const sourceLabel = ask.goalTitle ?? t`Conversation`;
  const eyebrowText = `${sourceLabel} · ${formatRelativeTime(ask.createdAt)}`;
  const Icon = KIND_ICON[ask.kind];
  const title = ask.kind === "approval" ? t`One yes before I send this` : ask.text;
  const subtitle =
    ask.kind === "approval" ? ask.text : ask.kind === "proposal" ? ask.detail : undefined;
  const structuredDetail = ask.kind === "approval" ? ask.detail : undefined;
  const detailRows = structuredDetail ? parseDetailRows(structuredDetail) : null;

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
    <Surface tone="attention" className="flex flex-col gap-3 px-5 py-4">
      {onOpenSource ? (
        <button
          type="button"
          onClick={onOpenSource}
          className="self-start text-start transition-colors hover:text-foreground"
        >
          <Eyebrow>{eyebrowText}</Eyebrow>
        </button>
      ) : (
        <Eyebrow>{eyebrowText}</Eyebrow>
      )}

      <div className="flex items-start gap-2.5">
        <Icon
          size={16}
          strokeWidth={1.75}
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-warning"
        />
        <div className="min-w-0 flex-1">
          <h3 className="text-[15.5px] leading-[1.4] font-medium text-foreground">{title}</h3>
          {subtitle ? (
            <div className="mt-1 text-[13.5px] leading-[1.5] text-muted-foreground">
              <ChatMarkdown>{subtitle}</ChatMarkdown>
            </div>
          ) : null}
        </div>
      </div>

      {structuredDetail ? (
        detailRows ? (
          <DetailRows rows={detailRows} />
        ) : (
          <p className="whitespace-pre-wrap text-[13.5px] leading-[1.6] text-muted-foreground">
            {structuredDetail}
          </p>
        )
      ) : null}

      {ask.input ? (
        <form
          className="flex flex-col gap-2"
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
        <div className="flex flex-wrap gap-1.5">
          {ask.choices.map((choice, index) => (
            <Button
              key={choice.id}
              variant={index === 0 ? "default" : "outline"}
              className="h-auto justify-start whitespace-normal px-3.5 py-2.5 text-start font-normal"
              disabled={submitting}
              onClick={() => void submit(choice.id)}
            >
              {pending === choice.id ? <Trans>Sending…</Trans> : choice.label}
            </Button>
          ))}
        </div>
      )}

      {error ? <p className="text-[13px] text-destructive">{error}</p> : null}
    </Surface>
  );
}
