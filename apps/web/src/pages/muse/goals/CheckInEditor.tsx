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
    <div className="flex flex-col gap-2.5">
      {schedules.length === 0 ? (
        <p className="text-[13.5px] text-muted-foreground">
          <Trans>None</Trans>
        </p>
      ) : (
        <div className="flex flex-col gap-2">
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
      <div className="flex items-center justify-between gap-3">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => update([...schedules, defaultCronPreset()])}
        >
          <Plus />
          <Trans>Add check-in</Trans>
        </Button>
        <span className="text-[12px] text-muted-foreground/70">{timezone}</span>
      </div>
      {dirty ? (
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={saving} onClick={() => void save()}>
            {saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
          </Button>
          {error ? <span className="text-[13px] text-destructive">{error}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
