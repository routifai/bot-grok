import { type CronPreset, cronFromPreset, defaultCronPreset, presetFromCron } from "@aiden/core";
import { Button } from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { RoutineSchedule } from "../../RoutineSchedule";

/** The Check-in schedule editor for a Goal, reusing RoutineSchedule (same cron shape). */
export function CheckInEditor({
  crons,
  timezone,
  saving,
  onSave,
}: {
  crons: string[];
  timezone: string;
  saving: boolean;
  onSave: (crons: string[]) => Promise<void>;
}) {
  const { t } = useLingui();
  const [schedules, setSchedules] = useState<CronPreset[]>(() => crons.map(presetFromCron));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update(next: CronPreset[]) {
    setSchedules(next);
    setDirty(true);
  }

  async function save() {
    setError(null);
    try {
      await onSave(schedules.map(cronFromPreset));
      setDirty(false);
    } catch {
      setError(t`Could not save`);
    }
  }

  return (
    <div>
      <div className="divide-y divide-border/70 overflow-hidden rounded-[22px] bg-card ring-1 ring-border/50">
        {schedules.map((preset, index) => (
          <div key={index} className="relative p-3 pe-11">
            <RoutineSchedule
              value={preset}
              onChange={(next) => update(schedules.map((item, i) => (i === index ? next : item)))}
            />
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t`Remove check-in`}
              onClick={() => update(schedules.filter((_, i) => i !== index))}
              className="absolute top-4 end-3 rounded-full text-muted-foreground"
            >
              <X />
            </Button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => update([...schedules, defaultCronPreset()])}
          className="flex min-h-[52px] w-full items-center gap-2.5 px-5 text-start text-[15.5px] text-primary transition-colors hover:bg-accent/50"
        >
          <Plus size={17} strokeWidth={2.25} />
          <Trans>Add a check-in</Trans>
        </button>
      </div>
      <p className="px-4 pt-2 text-[13px] text-muted-foreground">
        {schedules.length === 0 ? (
          <Trans>I'll message you with progress at these times. Times use {timezone}.</Trans>
        ) : (
          <Trans>Times use {timezone}.</Trans>
        )}
      </p>
      {dirty ? (
        <div className="mt-3 flex items-center gap-2">
          <Button className="rounded-full px-4" disabled={saving} onClick={() => void save()}>
            {saving ? <Trans>Saving…</Trans> : <Trans>Save check-ins</Trans>}
          </Button>
          {error ? <span className="text-[13px] text-destructive">{error}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
