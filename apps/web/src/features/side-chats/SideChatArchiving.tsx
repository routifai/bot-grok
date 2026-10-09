import { useLingui } from "@lingui/react/macro";
import type { Archiving } from "@nova/contracts";
import { SIDE_CHAT_ARCHIVE_DAYS } from "@nova/contracts";
import { useEffect, useId, useState } from "react";
import { rpc } from "../../lib/rpc";
import { MUSE_INSET_GROUP } from "./ui";

type Days = Archiving["sideChatAutoArchiveDays"];

const SELECT =
  "rounded-lg bg-muted px-2.5 py-1.5 text-[15px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";

// A deployment default that is not one of the choices shows as the closest one.
function nearest(days: number): Days {
  return SIDE_CHAT_ARCHIVE_DAYS.reduce((best, d) =>
    Math.abs(d - days) < Math.abs(best - days) ? d : best,
  );
}

/** One grouped row in Settings: when side chats archive themselves. Saves on change. */
export function SideChatArchiving({ botId }: { botId: string }) {
  const { t } = useLingui();
  const id = useId();
  const [days, setDays] = useState<Days | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDays(undefined);
    void rpc.muse.archiving({ botId }).then((next) => {
      if (!cancelled) setDays(next.sideChatAutoArchiveDays);
    });
    return () => {
      cancelled = true;
    };
  }, [botId]);

  async function save(next: Days, previous: Days) {
    setDays(next);
    setError(null);
    try {
      const saved = await rpc.muse.updateArchiving({ botId, sideChatAutoArchiveDays: next });
      setDays(saved.sideChatAutoArchiveDays);
    } catch (err) {
      setDays(previous);
      setError(err instanceof Error ? err.message : t`Could not save`);
    }
  }

  if (days === undefined) return null;

  const labels: Record<string, string> = {
    never: t`Never`,
    "1": t`After a day`,
    "7": t`After a week`,
    "30": t`After a month`,
  };

  return (
    <div data-testid="side-chat-archiving">
      <div className={MUSE_INSET_GROUP}>
        <div className="flex min-h-[52px] items-center justify-between gap-4 px-4">
          <label htmlFor={id} className="text-[16px] text-foreground">
            {t`Archive side chats`}
          </label>
          <select
            id={id}
            value={days === null ? "never" : String(nearest(days))}
            className={SELECT}
            onChange={(event) => {
              const value = event.target.value;
              void save(value === "never" ? null : (Number(value) as Days), days);
            }}
          >
            {["never", ...SIDE_CHAT_ARCHIVE_DAYS.map(String)].map((value) => (
              <option key={value} value={value}>
                {labels[value]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error ? (
        <p role="alert" className="px-4 pt-2 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
