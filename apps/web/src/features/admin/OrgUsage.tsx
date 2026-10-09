import { Trans, useLingui } from "@lingui/react/macro";
import type { EngineAdminUsage } from "@nova/contracts";
import { useEffect, useState } from "react";
import { errorText, formatUsd } from "../../../lib/engine-models";
import { rpc } from "../../../lib/rpc";
import { SettingsGroup, SettingsRow, SettingsSegmented } from "./kit";

type Window = "day" | "month";

/** Cost per day as plain bars: the tallest day fills the height, each bar names its day and cost. */
export function DayBars({ days, locale }: { days: EngineAdminUsage["byDay"]; locale: string }) {
  const max = Math.max(...days.map((day) => day.costUsd), 0);
  if (days.length === 0 || max <= 0) return null;
  return (
    <div className="px-3 pb-3 pt-2">
      <div
        role="img"
        aria-label={days.map((day) => `${day.day}: ${formatUsd(day.costUsd, locale)}`).join(", ")}
        className="flex h-20 items-end gap-1"
      >
        {days.map((day) => (
          <div
            key={day.day}
            title={`${day.day} · ${formatUsd(day.costUsd, locale)}`}
            className="min-w-1 flex-1 rounded-t-[3px] bg-tint/80"
            style={{ height: `${Math.max(4, Math.round((day.costUsd / max) * 100))}%` }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-ink-3">
        <span>{days[0]?.day.slice(5)}</span>
        <span>{days[days.length - 1]?.day.slice(5)}</span>
      </div>
    </div>
  );
}

/** What the organization spent on models: the month or today, in total, by person and by day. */
export function OrgUsage() {
  const { t, i18n } = useLingui();
  const locale = i18n.locale;
  const [window, setWindow] = useState<Window>("month");
  const [usage, setUsage] = useState<EngineAdminUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void rpc.engineAdmin
      .usage({ window })
      .then((next) => {
        if (!cancelled) setUsage(next);
      })
      .catch((err) => {
        if (!cancelled) setError(errorText(err, t`Could not load usage.`));
      });
    return () => {
      cancelled = true;
    };
  }, [window, t]);

  return (
    <div data-testid="org-usage" className="flex flex-col gap-6">
      <SettingsGroup>
        <SettingsSegmented
          label={t`Period`}
          testId="usage-window"
          value={window}
          options={[
            { value: "month", label: t`This month` },
            { value: "day", label: t`Today` },
          ]}
          onChange={setWindow}
        />
      </SettingsGroup>
      {error ? (
        <p role="alert" className="text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
      {usage && usage.window === window ? (
        <>
          <SettingsGroup>
            <SettingsRow
              label={<Trans>Total</Trans>}
              value={<span data-testid="usage-total">{formatUsd(usage.totalUsd, locale)}</span>}
            />
            {window === "month" ? <DayBars days={usage.byDay} locale={locale} /> : null}
          </SettingsGroup>
          {usage.byUser.length ? (
            <SettingsGroup title={<Trans>By person</Trans>}>
              {usage.byUser.map((row) => (
                <SettingsRow
                  key={row.userId}
                  label={row.userId}
                  value={formatUsd(row.costUsd, locale)}
                />
              ))}
            </SettingsGroup>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
