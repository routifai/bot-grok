import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Live } from "@superchat/contracts";
import { Button, Checkbox, Label } from "@superchat/ui-web";
import type { useLive } from "./useLive";

/** "Mon 8:00" for an engine timestamp in epoch seconds. */
export const whenText = (epochSeconds: number): string =>
  new Date(epochSeconds * 1000).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });

/** "total-revenue" -> "Total revenue". */
const humanize = (id: string) => {
  const words = id.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : id;
};

/**
 * Under the header: what the newest update changed (a chip per part, undo, "Show changes"), the
 * parts the person changed that the source disagrees with, and an open issue as one quiet line.
 */
export function LiveBar({
  live,
  api,
  newest,
  showChanges,
  onShowChanges,
  onPick,
}: {
  live: Live;
  api: ReturnType<typeof useLive>;
  /** The page on screen is the version the last update made. */
  newest: boolean;
  showChanges: boolean;
  onShowChanges: (on: boolean) => void;
  onPick: (id: string) => void;
}) {
  const { t } = useLingui();
  const update = newest ? live.lastUpdate : null;
  const applied = update?.applied ?? [];
  const suggestions = live.lastUpdate?.suggestions ?? [];
  if (!applied.length && !suggestions.length && !live.openIssue) return null;
  return (
    <div
      data-testid="live-bar"
      className="flex flex-col gap-2 border-b border-border bg-muted/40 px-4 py-2.5 text-[12.5px]"
    >
      {update && applied.length ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="font-medium">
            {t`Updated ${whenText(update.at)}`} ·{" "}
            {plural(applied.length, { one: "# change", other: "# changes" })}
          </span>
          <span className="flex min-w-0 flex-wrap gap-1.5">
            {applied.map((change) => (
              <button
                type="button"
                key={change.id}
                data-testid="live-chip"
                title={`${change.before} → ${change.after}`}
                onClick={() => onPick(change.id)}
                className="rounded-full bg-accent px-2 py-0.5 text-[12px] text-foreground outline-none hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring"
              >
                {humanize(change.id)}
              </button>
            ))}
          </span>
          <span className="flex-1" />
          <Label className="gap-1.5 text-[12px] font-normal text-muted-foreground">
            <Checkbox
              checked={showChanges}
              onCheckedChange={(checked) => onShowChanges(checked === true)}
            />
            {t`Show changes`}
          </Label>
          <Button variant="ghost" size="sm" onClick={() => void api.undo()}>
            {t`Undo this update`}
          </Button>
        </div>
      ) : null}
      {suggestions.map((suggestion) => (
        <div key={suggestion.id} data-testid="live-suggestion" className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">
            {t`Source says ${suggestion.sourceValue}, you wrote ${suggestion.yours}`}
          </span>
          <Button variant="ghost" size="sm" onClick={() => void api.accept(suggestion.id)}>
            {t`Use source value`}
          </Button>
        </div>
      ))}
      {live.openIssue ? (
        <p data-testid="live-issue" className="text-muted-foreground">
          {live.openIssue}
        </p>
      ) : null}
      {api.error ? <p className="text-destructive">{api.error}</p> : null}
    </div>
  );
}
