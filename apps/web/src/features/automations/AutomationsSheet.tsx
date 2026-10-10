import { Trans, useLingui } from "@lingui/react/macro";
import type { Automation, AutomationSchedule } from "@nova/contracts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  NativeSelect,
  NativeSelectOption,
  Switch,
  Textarea,
} from "@nova/ui-web";
import { Ellipsis, Play, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { formatRelativeTime } from "../../lib/relative-time";
import { DockSheet, DockSheetHeader } from "../../pages/muse/chrome/DockSheet";
import { EmptyState, PRIMARY_BUTTON, QUIET_BUTTON } from "../../pages/muse/ui";
import { CardSkeletonList } from "../../pages/muse/ui/CardSkeleton";
import { describeSchedule, WEEKDAYS } from "./schedule";
import { type AutomationsWire, useAutomations } from "./useAutomations";

const FIELD =
  "min-h-11 w-full rounded-xl border border-glass-line bg-black/20 px-3.5 text-[14px] text-foreground placeholder:text-ink-2";
const LABEL = "text-[13px] font-medium text-ink-2";

function nextRun(automation: Automation, locale: string | undefined): string {
  if (!automation.enabled) return "Paused";
  if (!automation.nextRunAt) return "Not scheduled";
  const date = new Date(automation.nextRunAt);
  if (Number.isNaN(date.getTime())) return "Not scheduled";
  return date.toLocaleString(locale || "en", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function lastRun(automation: Automation): string {
  if (!automation.lastRunAt) return "Never run";
  const when = formatRelativeTime(automation.lastRunAt);
  return automation.lastRunStatus === "failed" ? `Failed ${when}` : `Ran ${when}`;
}

function NewAutomationForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (input: {
    name: string;
    prompt: string;
    schedule: AutomationSchedule;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [frequency, setFrequency] = useState<AutomationSchedule["frequency"]>("daily");
  const [weekday, setWeekday] = useState(0);
  const [monthDay, setMonthDay] = useState(1);
  const [time, setTime] = useState("09:00");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !name.trim() || !prompt.trim() || !time) return;
    setBusy(true);
    setError(null);
    const schedule: AutomationSchedule =
      frequency === "daily"
        ? { frequency, time }
        : frequency === "weekly"
          ? { frequency, time, weekday }
          : { frequency, time, monthDay };
    try {
      await onSubmit({ name: name.trim(), prompt: prompt.trim(), schedule });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not save this automation.`);
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      data-testid="automation-form"
      className="flex max-w-[640px] flex-col gap-4"
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="auto-name" className={LABEL}>{t`Name`}</label>
        <Input
          id="auto-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t`Weekly summary`}
          maxLength={120}
          className={FIELD}
          autoFocus
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="auto-prompt" className={LABEL}>{t`What should superchat do?`}</label>
        <Textarea
          id="auto-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={t`Summarize what changed in my files this week and tell me what needs attention.`}
          rows={4}
          maxLength={8000}
          className={`${FIELD} py-3`}
        />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="auto-freq" className={LABEL}>{t`Repeat`}</label>
          <NativeSelect
            id="auto-freq"
            value={frequency}
            onChange={(event) => setFrequency(event.target.value as typeof frequency)}
            aria-label={t`Repeat`}
          >
            <NativeSelectOption value="daily">{t`Daily`}</NativeSelectOption>
            <NativeSelectOption value="weekly">{t`Weekly`}</NativeSelectOption>
            <NativeSelectOption value="monthly">{t`Monthly`}</NativeSelectOption>
          </NativeSelect>
        </div>
        {frequency === "weekly" ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="auto-day" className={LABEL}>{t`On`}</label>
            <NativeSelect
              id="auto-day"
              value={weekday}
              onChange={(event) => setWeekday(Number(event.target.value))}
              aria-label={t`Day of the week`}
            >
              {WEEKDAYS.map((day, index) => (
                <NativeSelectOption key={day} value={index}>
                  {day}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        ) : null}
        {frequency === "monthly" ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="auto-monthday" className={LABEL}>{t`On day`}</label>
            <NativeSelect
              id="auto-monthday"
              value={monthDay}
              onChange={(event) => setMonthDay(Number(event.target.value))}
              aria-label={t`Day of the month`}
            >
              {Array.from({ length: 28 }, (_, index) => index + 1).map((day) => (
                <NativeSelectOption key={day} value={day}>
                  {day}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="auto-time" className={LABEL}>{t`At`}</label>
          <Input
            id="auto-time"
            type="time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
            className={`${FIELD} w-[130px]`}
            required
          />
        </div>
      </div>
      {error ? <p className="text-[13.5px] text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <button
          type="submit"
          className={PRIMARY_BUTTON}
          disabled={busy || !name.trim() || !prompt.trim()}
        >
          {busy ? t`Saving…` : t`Create automation`}
        </button>
        <button type="button" className={QUIET_BUTTON} onClick={onCancel} disabled={busy}>
          <Trans>Cancel</Trans>
        </button>
      </div>
    </form>
  );
}

function AutomationRow({
  automation,
  onToggle,
  onRun,
  onDelete,
}: {
  automation: Automation;
  onToggle: (on: boolean) => void;
  onRun: () => void;
  onDelete: () => void;
}) {
  const { t, i18n } = useLingui();
  return (
    <li
      data-testid="automation-row"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-glass-line bg-foreground/[0.04] p-4"
    >
      <div className="flex min-w-[200px] flex-1 flex-col gap-0.5">
        <span className="truncate text-[15px] font-medium text-foreground" dir="auto">
          {automation.name}
        </span>
        <span className="text-[13px] text-ink-2">{describeSchedule(automation.schedule)}</span>
      </div>
      <div className="flex min-w-[160px] flex-col gap-0.5 text-[13px] text-ink-2">
        <span>
          {t`Next`}: {nextRun(automation, i18n.locale)}
        </span>
        <span className={automation.lastRunStatus === "failed" ? "text-destructive" : undefined}>
          {lastRun(automation)}
        </span>
      </div>
      <button type="button" className={QUIET_BUTTON} onClick={onRun}>
        <Play size={14} aria-hidden="true" className="me-1.5" />
        <Trans>Run now</Trans>
      </button>
      <Switch
        checked={automation.enabled}
        onCheckedChange={onToggle}
        aria-label={t`${automation.name} is on`}
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={t`More actions for ${automation.name}`}
              className="grid size-9 place-items-center rounded-lg text-ink-2 hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-ring"
            />
          }
        >
          <Ellipsis size={18} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trans>Delete</Trans>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/** Automations: the engine's scheduled tasks, as a list and a plain-choices form. */
export function AutomationsSheet({
  botId,
  open,
  onClose,
  wire,
}: {
  botId: string;
  open: boolean;
  onClose: () => void;
  /** Dev previews pass their own; the app uses the live RPC. */
  wire?: AutomationsWire;
}) {
  const { t } = useLingui();
  const { state, create, setEnabled, runNow, remove } = useAutomations(botId, open, wire);
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = (action: () => Promise<void>) => {
    setActionError(null);
    action().catch((cause: unknown) =>
      setActionError(cause instanceof Error ? cause.message : t`That did not work.`),
    );
  };

  return (
    <DockSheet
      open={open}
      title={t`Automations`}
      onClose={() => {
        setCreating(false);
        onClose();
      }}
    >
      <DockSheetHeader
        title={creating ? t`New automation` : t`Automations`}
        subtitle={
          creating
            ? t`Pick a time and I'll do this for you.`
            : t`Things I do for you on a schedule.`
        }
      >
        {creating ? null : (
          <button type="button" className={PRIMARY_BUTTON} onClick={() => setCreating(true)}>
            <Plus size={16} aria-hidden="true" className="me-1.5" />
            <Trans>New automation</Trans>
          </button>
        )}
      </DockSheetHeader>
      <div className="rk-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        {creating ? (
          <NewAutomationForm
            onCancel={() => setCreating(false)}
            onSubmit={async (input) => {
              await create(input);
              setCreating(false);
            }}
          />
        ) : state.status === "loading" ? (
          <CardSkeletonList count={3} />
        ) : state.status === "error" ? (
          <p className="py-10 text-[14px] text-destructive">{state.message}</p>
        ) : state.automations.length === 0 ? (
          <EmptyState headline={t`No automations yet`}>
            {t`Create one and I'll run it on its own, every day, week or month.`}
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-3" data-testid="automation-list">
            {state.automations.map((automation) => (
              <AutomationRow
                key={automation.id}
                automation={automation}
                onToggle={(on) => act(() => setEnabled(automation.id, on))}
                onRun={() => act(() => runNow(automation.id))}
                onDelete={() => act(() => remove(automation.id))}
              />
            ))}
          </ul>
        )}
        {actionError ? <p className="text-[13.5px] text-destructive">{actionError}</p> : null}
      </div>
    </DockSheet>
  );
}
