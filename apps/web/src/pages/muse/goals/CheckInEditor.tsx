import { Trans, useLingui } from "@lingui/react/macro";
import { type CronPreset, cronFromPreset, defaultCronPreset, presetFromCron } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
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
      <div className="flex items-baseline gap-2 text-sm text-muted-foreground">
        <Trans>Check-in</Trans>
        <span className="text-xs text-muted-foreground/70">{timezone}</span>
      </div>
      {schedules.length === 0 ? (
        <p className="mt-2 text-[13px] text-muted-foreground/80">
          <Trans>None</Trans>
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          {schedules.map((preset, index) => (
            <div key={index} className="relative">
              <RoutineSchedule
                value={preset}
                onChange={(next) => update(schedules.map((item, i) => (i === index ? next : item)))}
              />
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t`Remove check-in`}
                onClick={() => update(schedules.filter((_, i) => i !== index))}
                className="absolute top-2 right-2 text-muted-foreground"
              >
                <X />
              </Button>
            </div>
          ))}
        </div>
      )}
      <Button
        variant="outline"
        className="mt-2 h-auto w-full rounded-xl py-2.5"
        onClick={() => update([...schedules, defaultCronPreset()])}
      >
        <Plus />
        <Trans>Add check-in</Trans>
      </Button>
      {dirty ? (
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" disabled={saving} onClick={() => void save()}>
            {saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
          </Button>
          {error ? <span className="text-[13px] text-destructive">{error}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
