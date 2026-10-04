import { cn, Input } from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronRight, File, Folder, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatRelativeTime } from "../../../lib/relative-time";
import { rpc } from "../../../lib/rpc";
import { FilePreviewDialog } from "./FilePreviewDialog";

type Entry = Awaited<ReturnType<typeof rpc.files.list>>["entries"][number];
type Dir = { status: "loading" } | { status: "error" } | { status: "ready"; entries: Entry[] };

function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The Computer panel's Files view: the Muse's workspace as a lazy-expanding tree, newest first,
 * with a filter and refresh. Opening a file shows the shared preview. `refreshKey` bumps when a
 * turn completes so the tree follows the Muse's work.
 */
export function FilesTab({ botId, refreshKey }: { botId: string; refreshKey: number }) {
  const { t } = useLingui();
  const [dirs, setDirs] = useState<Record<string, Dir>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const botRef = useRef(botId);
  botRef.current = botId;

  const load = useCallback(
    async (path: string, quiet = false) => {
      if (!quiet) setDirs((current) => ({ ...current, [path]: { status: "loading" } }));
      try {
        const { entries } = await rpc.files.list({ botId, path });
        if (botRef.current !== botId) return;
        setDirs((current) => ({ ...current, [path]: { status: "ready", entries } }));
      } catch {
        if (botRef.current !== botId) return;
        setDirs((current) =>
          quiet && current[path]?.status === "ready"
            ? current
            : { ...current, [path]: { status: "error" } },
        );
      }
    },
    [botId],
  );

  const refresh = useCallback(() => {
    void load("", true);
    for (const path of expandedRef.current) void load(path, true);
  }, [load]);

  // A different Muse starts from its own root.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the Muse changes
  useEffect(() => {
    setDirs({});
    setExpanded(new Set());
    setFilter("");
    setPreview(null);
    void load("");
  }, [botId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh only when the key bumps
  useEffect(() => {
    if (refreshKey > 0) refresh();
  }, [refreshKey]);

  const toggle = (path: string) => {
    const open = expanded.has(path);
    setExpanded((current) => {
      const next = new Set(current);
      if (open) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!open) void load(path);
  };

  const root = dirs[""];
  const query = filter.trim().toLowerCase();

  const renderRow = (entry: Entry, depth: number, showPath = false) => {
    const isDir = entry.type === "directory";
    const open = expanded.has(entry.path);
    return (
      <li key={entry.path}>
        <button
          type="button"
          data-testid="file-row"
          aria-expanded={isDir ? open : undefined}
          onClick={() => (isDir ? toggle(entry.path) : setPreview(entry.path))}
          style={{ paddingInlineStart: `${depth * 14 + 8}px` }}
          className="flex w-full items-center gap-2 rounded-lg py-1.5 pe-2 text-start text-[13.5px] hover:bg-muted/70 focus-visible:bg-muted/70 focus-visible:outline-none"
        >
          {isDir ? (
            <ChevronRight
              size={14}
              strokeWidth={1.8}
              className={cn(
                "shrink-0 text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
              aria-hidden
            />
          ) : (
            <span className="w-3.5 shrink-0" aria-hidden />
          )}
          {isDir ? (
            <Folder
              size={15}
              strokeWidth={1.6}
              className="shrink-0 text-muted-foreground"
              aria-hidden
            />
          ) : (
            <File
              size={15}
              strokeWidth={1.6}
              className="shrink-0 text-muted-foreground"
              aria-hidden
            />
          )}
          <span className="min-w-0 flex-1 truncate" dir="auto" title={entry.path}>
            {showPath ? entry.path : entry.name}
          </span>
          <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
            {formatSize(entry.size)}
          </span>
          <span className="w-[62px] shrink-0 text-end text-[12px] text-muted-foreground">
            {formatRelativeTime(new Date(entry.modifiedAt * 1000).toISOString())}
          </span>
        </button>
        {isDir && open ? renderDir(entry.path, depth + 1) : null}
      </li>
    );
  };

  const renderDir = (path: string, depth: number) => {
    const dir = dirs[path];
    if (!dir || dir.status === "loading") {
      return (
        <p
          className="py-1.5 text-[12.5px] text-muted-foreground"
          style={{ paddingInlineStart: `${depth * 14 + 8}px` }}
        >
          <Trans>Loading…</Trans>
        </p>
      );
    }
    if (dir.status === "error") {
      return (
        <p
          className="py-1.5 text-[12.5px] text-muted-foreground"
          style={{ paddingInlineStart: `${depth * 14 + 8}px` }}
        >
          <Trans>Could not load this.</Trans>
        </p>
      );
    }
    if (dir.entries.length === 0) return null;
    return <ul>{dir.entries.map((entry) => renderRow(entry, depth))}</ul>;
  };

  const loadedEntries = Object.values(dirs).flatMap((dir) =>
    dir.status === "ready" ? dir.entries : [],
  );
  const matches = query
    ? loadedEntries
        .filter((entry) => entry.path.toLowerCase().includes(query))
        .sort((a, b) => b.modifiedAt - a.modifiedAt)
    : [];

  return (
    <div data-testid="computer-files">
      <div className="mb-3 flex items-center gap-2">
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t`Filter files`}
          aria-label={t`Filter files`}
          className="h-8 flex-1 text-[13.5px]"
        />
        <button
          type="button"
          aria-label={t`Refresh files`}
          onClick={refresh}
          className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <RefreshCw size={15} strokeWidth={1.7} />
        </button>
      </div>
      {!root || root.status === "loading" ? (
        <p className="text-[13.5px] text-muted-foreground">
          <Trans>Loading…</Trans>
        </p>
      ) : root.status === "error" ? (
        <p className="text-[13.5px] text-muted-foreground">
          <Trans>Could not load this.</Trans>
        </p>
      ) : root.entries.length === 0 ? (
        <p className="text-[13.5px] text-muted-foreground">
          <Trans>No files yet.</Trans>
        </p>
      ) : query ? (
        matches.length === 0 ? (
          <p className="text-[13.5px] text-muted-foreground">
            <Trans>No matches.</Trans>
          </p>
        ) : (
          <ul>{matches.map((entry) => renderRow(entry, 0, true))}</ul>
        )
      ) : (
        <ul>{root.entries.map((entry) => renderRow(entry, 0))}</ul>
      )}
      {preview ? (
        <FilePreviewDialog
          botId={botId}
          path={preview}
          onOpenChange={(open) => {
            if (!open) setPreview(null);
          }}
        />
      ) : null}
    </div>
  );
}
