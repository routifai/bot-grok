import { cn } from "@aiden/ui-web";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { MessageCircle, Search } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { RestoreButton } from "../chrome/RestoreButton";
import {
  FORK_FILTERS,
  FORK_TONE_CLASS,
  type ForkFilter,
  type ForkGroup,
  type ForkRow,
  type ForkStatus,
  filterForks,
  forkCounts,
  groupForks,
} from "./forkModel";
import { BranchIcon, forkTime } from "./forkParts";

/** "Chat | Forks" in the Conversation header: the transcript, or every fork as one list. */
export function ForkViewSwitch({
  view,
  onChange,
}: {
  view: "chat" | "forks";
  onChange: (view: "chat" | "forks") => void;
}) {
  const { t } = useLingui();
  const item = (value: "chat" | "forks", icon: ReactNode, label: string) => (
    <button
      type="button"
      aria-pressed={view === value}
      onClick={() => onChange(value)}
      className="inline-flex h-[26px] items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-xs"
    >
      {icon}
      <span className="max-sm:sr-only">{label}</span>
    </button>
  );
  return (
    <fieldset
      aria-label={t`View`}
      className="m-0 inline-flex min-w-0 gap-0.5 rounded-[10px] border-0 bg-selection p-[3px]"
    >
      {item("chat", <MessageCircle size={13} strokeWidth={1.75} aria-hidden="true" />, t`Chat`)}
      {item("forks", <BranchIcon size={13} />, t`Forks`)}
    </fieldset>
  );
}

function useForkLabels() {
  const { t } = useLingui();
  const filter: Record<ForkFilter, string> = {
    all: t`All`,
    live: t`Working`,
    open: t`Open`,
    added: t`Added`,
    archived: t`Archived`,
  };
  const group: Record<ForkGroup, string> = {
    today: t`Today`,
    yesterday: t`Yesterday`,
    week: t`This week`,
    earlier: t`Earlier`,
  };
  return { filter, group };
}

const TAG_CLASS: Record<ForkStatus, string> = {
  live: "text-foreground",
  open: "text-ink-2",
  added: "text-success",
  archived: "text-ink-3",
};

/**
 * Every fork of the Conversation as one list (ADR 0010): search over the title and the message
 * it came from, a state filter with counts, and groups by when each last moved. A row opens the
 * fork over its message in the Conversation.
 */
export function AllForks({
  rows,
  filter,
  onFilter,
  onOpen,
  onRestore,
  now,
}: {
  rows: readonly ForkRow[];
  filter: ForkFilter;
  onFilter: (filter: ForkFilter) => void;
  onOpen: (row: ForkRow) => void;
  /** Restores an archived fork; without it archived rows have no Restore. */
  onRestore?: (row: ForkRow) => Promise<unknown>;
  now?: Date;
}) {
  const { t } = useLingui();
  const labels = useForkLabels();
  const [query, setQuery] = useState("");
  const counts = useMemo(() => forkCounts(rows), [rows]);
  const groups = useMemo(
    () => groupForks(filterForks(rows, { filter, query }), now ?? new Date()),
    [rows, filter, query, now],
  );
  return (
    <div data-testid="all-forks" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-line px-4 py-3.5 md:px-5">
        <label className="flex h-9 min-w-0 flex-[1_1_220px] items-center gap-2 rounded-[10px] border border-line bg-card px-3 text-ink-3">
          <Search size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="sr-only">
            <Trans>Search forks</Trans>
          </span>
          <input
            type="search"
            value={query}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t`Search ${counts.all} forks`}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-ink-3"
          />
        </label>
        <fieldset
          aria-label={t`Filter forks`}
          className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0"
        >
          {FORK_FILTERS.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => onFilter(key)}
              className="inline-flex h-[30px] items-center gap-1 rounded-full border border-line bg-card px-3 text-[12.5px] font-medium text-ink-2 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background"
            >
              {labels.filter[key]}
              <span className="font-mono text-[11px] tabular-nums opacity-70">{counts[key]}</span>
            </button>
          ))}
        </fieldset>
      </div>
      <div className="rk-scroll min-h-0 flex-1 overflow-y-auto px-3 pt-2 pb-6 md:px-5">
        {groups.length === 0 ? (
          <p className="p-8 text-center text-[13px] text-ink-3">
            <Trans>No forks match.</Trans>
          </p>
        ) : (
          groups.map(({ group, rows: inGroup }) => (
            <section key={group} aria-label={labels.group[group]}>
              <h3 className="px-1 pt-4 pb-1.5 text-[12px] font-semibold text-ink-3">
                {labels.group[group]}
              </h3>
              {inGroup.map((row) => (
                <div key={row.chatId} className="flex items-center gap-2">
                  <button
                    type="button"
                    data-testid="all-forks-row"
                    onClick={() => onOpen(row)}
                    className="grid min-w-0 flex-1 grid-cols-[4px_minmax(0,1fr)_auto] items-center gap-x-3.5 rounded-xl px-3 py-2.5 text-start transition-colors hover:bg-selection focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <span
                      aria-hidden="true"
                      className={cn("h-[38px] w-1 rounded", FORK_TONE_CLASS[row.tone].bg)}
                    />
                    <span className="min-w-0">
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className="truncate text-[14px] font-semibold text-foreground"
                          dir="auto"
                        >
                          {row.title}
                        </span>
                        <span
                          className={cn(
                            "shrink-0 rounded-full bg-selection px-[7px] py-px text-[11px] font-semibold",
                            TAG_CLASS[row.status],
                          )}
                        >
                          {labels.filter[row.status]}
                        </span>
                      </span>
                      {row.anchorText ? (
                        <span className="mt-0.5 block truncate text-[12.5px] text-ink-3" dir="auto">
                          {t`from “${row.anchorText}”`}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex flex-col items-end gap-0.5 text-end font-mono text-[11.5px] whitespace-nowrap tabular-nums text-ink-3">
                      {row.project ? (
                        <span className="max-w-[160px] truncate font-sans text-[12px]" dir="auto">
                          {row.project.name}
                        </span>
                      ) : null}
                      {row.replies !== null ? (
                        <span>{plural(row.replies, { one: "# reply", other: "# replies" })}</span>
                      ) : null}
                      <span>{forkTime(row.updatedAt, now)}</span>
                    </span>
                  </button>
                  {row.status === "archived" && onRestore ? (
                    <RestoreButton className="shrink-0" onRestore={() => onRestore(row)} />
                  ) : null}
                </div>
              ))}
            </section>
          ))
        )}
      </div>
    </div>
  );
}
