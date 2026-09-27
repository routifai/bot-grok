import { Trans, useLingui } from "@lingui/react/macro";
import type { MuseSettings, Proactivity } from "@rakazo/contracts";
import { DEFAULT_MUSE_SETTINGS, PROACTIVITY_LEVELS } from "@rakazo/contracts";
import { Input, Switch, Tabs, TabsList, TabsTrigger } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { rpc } from "../../lib/rpc";

const DEFAULT_QUIET_HOURS = DEFAULT_MUSE_SETTINGS.quietHours ?? "22:00-08:00";

function splitQuietHours(range: string): [string, string] {
  const [start, end] = range.split("-");
  return [start ?? "22:00", end ?? "08:00"];
}

function ProactivityLabel({ level }: { level: Proactivity }) {
  switch (level) {
    case "off":
      return <Trans>Off</Trans>;
    case "low":
      return <Trans>Low</Trans>;
    case "normal":
      return <Trans>Normal</Trans>;
    case "high":
      return <Trans>High</Trans>;
  }
}

/**
 * How eagerly the Muse works on Goals on its own, and the window it stays quiet in.
 * Saves each change immediately (optimistic); reverts and shows the error inline on failure.
 */
export function ProactivitySettings({ botId }: { botId: string }) {
  const { t } = useLingui();
  const ids = useId();
  const [settings, setSettings] = useState<MuseSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSettings(null);
    void rpc.muse.settings({ botId }).then((next) => {
      if (!cancelled) setSettings(next);
    });
    return () => {
      cancelled = true;
    };
  }, [botId]);

  async function save(patch: Partial<MuseSettings>, previous: MuseSettings) {
    setSettings({ ...previous, ...patch });
    setError(null);
    try {
      const next = await rpc.muse.updateSettings({ botId, ...patch });
      setSettings(next);
    } catch (err) {
      setSettings(previous);
      setError(err instanceof Error ? err.message : t`Could not save`);
    }
  }

  if (!settings) return null;

  const [start, end] = splitQuietHours(settings.quietHours ?? DEFAULT_QUIET_HOURS);
  const quietHoursOn = settings.quietHours !== null;

  return (
    <div data-testid="proactivity-settings" className="mt-6 pt-4 border-t border-border/20">
      <div className="text-[13.5px] text-muted-foreground">
        <Trans>Proactivity</Trans>
      </div>
      <Tabs
        value={settings.proactivity}
        onValueChange={(value) => void save({ proactivity: value as Proactivity }, settings)}
        className="mt-2"
      >
        <TabsList className="w-full" aria-label={t`Proactivity`}>
          {PROACTIVITY_LEVELS.map((level) => (
            <TabsTrigger key={level} value={level} className="flex-1">
              <ProactivityLabel level={level} />
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="mt-4 flex items-center justify-between">
        <span id={`${ids}-quiet-hours-label`} className="text-[13.5px] text-muted-foreground">
          <Trans>Quiet hours</Trans>
        </span>
        <Switch
          id={`${ids}-quiet-hours`}
          checked={quietHoursOn}
          aria-labelledby={`${ids}-quiet-hours-label`}
          onCheckedChange={(checked) =>
            void save(
              { quietHours: checked ? (settings.quietHours ?? DEFAULT_QUIET_HOURS) : null },
              settings,
            )
          }
        />
      </div>
      {quietHoursOn ? (
        <div className="mt-2 flex items-center gap-2">
          <Input
            type="time"
            aria-label={t`Quiet hours start`}
            value={start}
            onChange={(event) => {
              const value = event.target.value;
              if (!value) return;
              void save({ quietHours: `${value}-${end}` }, settings);
            }}
          />
          <span aria-hidden="true" className="text-muted-foreground">
            –
          </span>
          <Input
            type="time"
            aria-label={t`Quiet hours end`}
            value={end}
            onChange={(event) => {
              const value = event.target.value;
              if (!value) return;
              void save({ quietHours: `${start}-${value}` }, settings);
            }}
          />
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
