import { ChatMarkdown } from "@aiden/chat-ui/web";
import type { Ask } from "@aiden/contracts";
import { Button, Input } from "@aiden/ui-web";
import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { BookmarkPlus, HelpCircle, ShieldCheck, Sparkles } from "lucide-react";
import { useState } from "react";
import { formatRelativeTime } from "../../../lib/relative-time";
import { DetailRows } from "../ui";

const KIND_ICON = {
  approval: ShieldCheck,
  proposal: Sparkles,
  question: HelpCircle,
  blocked_task: HelpCircle,
  skill_offer: BookmarkPlus,
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
 * Renders one open Ask (docs/muse/DESIGN.md, "Waiting on you") as a single quiet inbox
 * row: a small icon slot, a title, and one meta line saying where it came from and when.
 * Shared by the Feed and the Waiting-on-you sheet, so an Ask looks and answers the same
 * everywhere (CONTEXT.md: answering anywhere closes it everywhere). Matches the look of
 * `AskCard.tsx` (the Conversation's own ask block), but reads the `Ask` view type instead
 * of a thread message block's shape.
 */
export function AskItem({
  ask,
  onAnswer,
  onOpenSource,
}: {
  ask: Ask;
  onAnswer: (value: string) => Promise<void>;
  /** Called when the person taps the source in the meta line; omit to leave it inert. */
  onOpenSource?: () => void;
}) {
  const { t } = useLingui();
  const [text, setText] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitting = pending !== null;

  const sourceLabel = ask.goalTitle ?? t`Conversation`;
  const metaText = t`From ${sourceLabel} · ${formatRelativeTime(ask.createdAt)}`;
  const Icon = KIND_ICON[ask.kind];
  const engineApproval = ask.approval !== undefined;
  const title = engineApproval
    ? ask.text
    : ask.kind === "approval"
      ? t`One yes before I send this`
      : ask.text;
  const subtitle = engineApproval
    ? ask.detail
    : ask.kind === "approval"
      ? ask.text
      : ask.kind === "proposal" || ask.kind === "skill_offer"
        ? ask.detail
        : undefined;
  const structuredDetail = ask.kind === "approval" && !engineApproval ? ask.detail : undefined;
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
    <div className="flex gap-3 border-l-2 border-l-warning py-4 pl-3">
      <span
        aria-hidden="true"
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted"
      >
        <Icon size={15} strokeWidth={1.75} className="text-muted-foreground" />
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h3 className="text-[15px] leading-[1.4] font-medium text-foreground">{title}</h3>

        {onOpenSource ? (
          <button
            type="button"
            onClick={onOpenSource}
            className="self-start text-start text-[13px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {metaText}
          </button>
        ) : (
          <p className="text-[13px] text-muted-foreground">{metaText}</p>
        )}

        {subtitle ? (
          <div className="text-[13.5px] leading-[1.5] text-muted-foreground">
            <ChatMarkdown>{subtitle}</ChatMarkdown>
          </div>
        ) : null}

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
            className="flex flex-col gap-2 pt-1"
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
          <div className="flex flex-wrap gap-2 pt-1">
            {ask.choices.map((choice, index) => (
              <Button
                key={choice.id}
                variant={index === 0 ? "default" : "ghost"}
                disabled={submitting}
                onClick={() => void submit(choice.id)}
              >
                {pending === choice.id ? <Trans>Sending…</Trans> : choice.label}
              </Button>
            ))}
          </div>
        )}

        {error ? <p className="text-[13px] text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}

type AskGroupKey = "approvals" | "questions" | "plans";

const ASK_GROUP_ORDER: AskGroupKey[] = ["approvals", "questions", "plans"];

function askGroupKey(kind: Ask["kind"]): AskGroupKey {
  if (kind === "approval") return "approvals";
  if (kind === "proposal" || kind === "skill_offer") return "plans";
  return "questions";
}

export type AskGroup = { label: string | null; asks: Ask[] };

/**
 * Splits open Asks into small plain-heading groups (Approvals, Questions, Plans) once
 * there are enough of them that a flat list gets hard to scan (docs/muse/DESIGN.md,
 * "Group Asks under small plain headings only when there are more than 4"). Below that,
 * a single ungrouped bucket (`label: null`) keeps the list flat.
 */
export function groupAsks(asks: Ask[]): AskGroup[] {
  if (asks.length <= 4) return [{ label: null, asks }];
  const labels: Record<AskGroupKey, string> = {
    approvals: t`Approvals`,
    questions: t`Questions`,
    plans: t`Plans`,
  };
  return ASK_GROUP_ORDER.map((key) => ({
    label: labels[key],
    asks: asks.filter((ask) => askGroupKey(ask.kind) === key),
  })).filter((group) => group.asks.length > 0);
}

/**
 * A plain list of open Asks with hairline dividers between rows, grouped under small
 * headings once there are more than a handful (`groupAsks`). Shared by the Waiting-on-you
 * sheet and the Feed's pinned Asks so both read the same way.
 */
export function AskList({
  asks,
  onAnswer,
}: {
  asks: Ask[];
  onAnswer: (ask: Ask, value: string) => Promise<void>;
}) {
  const groups = groupAsks(asks);
  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <div key={group.label ?? "asks"} className="flex flex-col gap-2">
          {group.label ? (
            <h4 className="text-[12.5px] font-medium text-muted-foreground">{group.label}</h4>
          ) : null}
          <div className="flex flex-col divide-y divide-border">
            {group.asks.map((ask) => (
              <AskItem key={ask.id} ask={ask} onAnswer={(value) => onAnswer(ask, value)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
