import type { MuseSettings, Proactivity } from "@aiden/contracts";
import { DEFAULT_MUSE_SETTINGS, PROACTIVITY_LEVELS } from "@aiden/contracts";
import { cn, Switch } from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useId, useState } from "react";
import { localTimezone } from "../../lib/local-timezone";
import { rpc } from "../../lib/rpc";
import { MUSE_INSET_GROUP } from "./ui";

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

function ProactivityFooter({ level }: { level: Proactivity }) {
  switch (level) {
    case "off":
      return <Trans>I only work when you ask.</Trans>;
    case "low":
      return <Trans>I check on your Goals every few hours.</Trans>;
    case "normal":
      return <Trans>I check on your Goals about every hour.</Trans>;
    case "high":
      return <Trans>I keep working on your Goals throughout the day.</Trans>;
  }
}

const ROW = "flex min-h-[52px] items-center justify-between gap-4 px-4";
const TIME =
  "rounded-lg bg-muted px-2.5 py-1.5 text-[15px] tabular-nums text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * How eagerly the Muse works on Goals on its own, and the window it stays quiet in, as
 * iOS-style grouped rows. Saves each change immediately (optimistic); reverts and shows
 * the error inline on failure.
 */
export function ProactivitySettings({ botId }: { botId: string }) {
  const { t } = useLingui();
  const ids = useId();
  const [settings, setSettings] = useState<MuseSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timezone = localTimezone();

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

  // The only place that currently learns the person's time zone: quiet hours and the
  // daily Followed-topic digest (packages/adapters/src/muse/feed-jobs.ts) both read
  // User.timezone. Best effort — a failed save just leaves the previous value in place.
  useEffect(() => {
    void rpc.preferences.update({ timezone }).catch(() => undefined);
  }, [timezone]);

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
    <div data-testid="proactivity-settings" className="flex flex-col gap-8">
      <section>
        <h3 className="px-4 pb-2 text-[13.5px] text-muted-foreground">
          <Trans>Working on its own</Trans>
        </h3>
        <div className={cn(MUSE_INSET_GROUP, "p-1.5")}>
          <fieldset
            aria-label={t`Proactivity`}
            className="m-0 grid min-w-0 grid-cols-4 gap-1 rounded-[16px] border-0 bg-muted p-1"
          >
            {PROACTIVITY_LEVELS.map((level) => {
              const selected = settings.proactivity === level;
              return (
                <button
                  key={level}
                  type="button"
                  data-testid={`level-${level}`}
                  aria-pressed={selected}
                  onClick={() => {
                    if (!selected) void save({ proactivity: level }, settings);
                  }}
                  className={cn(
                    "rounded-[12px] py-2 text-[14.5px] font-medium transition-[background-color,box-shadow,color] duration-200",
                    selected
                      ? "bg-card text-foreground shadow-[0_1px_3px_rgb(0_0_0/0.12)]"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <ProactivityLabel level={level} />
                </button>
              );
            })}
          </fieldset>
        </div>
        <p className="px-4 pt-2 text-[13px] text-muted-foreground">
          <ProactivityFooter level={settings.proactivity} />
        </p>
      </section>

      <section>
        <div className={MUSE_INSET_GROUP}>
          <div className={ROW}>
            <span id={`${ids}-quiet-hours-label`} className="text-[16px] text-foreground">
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
            <>
              <div className="ms-4 border-t border-border/70" />
              <label className={ROW}>
                <span className="text-[16px] text-foreground">
                  <Trans>From</Trans>
                </span>
                <input
                  type="time"
                  aria-label={t`Quiet hours start`}
                  value={start}
                  className={TIME}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (!value) return;
                    void save({ quietHours: `${value}-${end}` }, settings);
                  }}
                />
              </label>
              <div className="ms-4 border-t border-border/70" />
              <label className={ROW}>
                <span className="text-[16px] text-foreground">
                  <Trans>Until</Trans>
                </span>
                <input
                  type="time"
                  aria-label={t`Quiet hours end`}
                  value={end}
                  className={TIME}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (!value) return;
                    void save({ quietHours: `${start}-${value}` }, settings);
                  }}
                />
              </label>
            </>
          ) : null}
        </div>
        <p className="px-4 pt-2 text-[13px] text-muted-foreground">
          <Trans>I won't work on Goals or message you during quiet hours.</Trans>
        </p>
        <p className="px-4 pt-1 text-[13px] text-muted-foreground">
          <Trans>Uses your time zone, {timezone}.</Trans>
        </p>
      </section>

      {error ? (
        <p role="alert" className="px-4 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
