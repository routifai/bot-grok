import { type CronPreset, cronFromPreset, presetFromCron } from "@aiden/core";
import { Button } from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { friendlyTimezone } from "../../../lib/local-timezone";
import { RoutineSchedule } from "../../RoutineSchedule";

/**
 * The Check-in schedule editor for a Goal, reusing RoutineSchedule (same cron shape). A Goal
 * has one schedule (the engine task that advances it), so it can be changed but not added to
 * or removed.
 */
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
          <div key={index} className="p-3">
            <RoutineSchedule
              flat
              value={preset}
              onChange={(next) => update(schedules.map((item, i) => (i === index ? next : item)))}
            />
          </div>
        ))}
      </div>
      <p className="px-4 pt-2 text-[13px] text-muted-foreground">
        <Trans>Times use {friendlyTimezone(timezone)}.</Trans>
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
