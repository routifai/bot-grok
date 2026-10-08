import { Trans, useLingui } from "@lingui/react/macro";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@nova/ui-web";
import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ArtifactKind } from "../../lib/artifact-kind";
import { artifactKind, KIND_ORDER, kindFacetLabel } from "../../lib/artifact-kind";
import { decodeArtifactBase64, downloadArtifactBytes } from "../../lib/artifact-open";
import { rpc } from "../../lib/rpc";
import { LibraryGlyph } from "./chrome/NovaGlyphs";
import { NovaTile } from "./chrome/NovaTile";
import { ArtifactPreviewDialog } from "./library/ArtifactPreviewDialog";
import { LibraryGrid, LibrarySkeletonGrid } from "./library/LibraryGrid";
import { SkillsPanel } from "./library/SkillsPanel";
import type { ArtifactSummary } from "./library/types";
import {
  EmptyState,
  MuseScreen,
  MuseWideCenter,
  ScreenHeader,
  ScreenHero,
  SegmentedControl,
} from "./ui";

/** A facet's count, quiet beside its label. */
function Count({ n }: { n: number }) {
  return <span className="text-ink-3 tabular-nums">{n}</span>;
}

const LIST_PAGE_SIZE = 60;
// Safety net against an unbounded fetch loop; a Library this size is not realistic.
const MAX_PAGES = 12;

const LIBRARY_SUGGESTIONS = [
  "Draft a one-pager on the new mortgage product",
  "Build a client meeting brief template",
];

/**
 * F7 · Library. Everything the Muse has made — pages, documents, files — from the
 * Conversation and every Goal log, searchable in one grid. `artifacts.listSpace` is
 * space-scoped with an optional bot filter, not thread-scoped, and Goal-log turns
 * create artifacts under the same bot id as the Conversation, so they all show up
 * here too without any backend change.
 */
export function LibraryScreen({
  botId,
  onSendIdea,
}: {
  botId: string;
  botName?: string;
  /** Starts a Conversation with a suggestion from the empty state. */
  onSendIdea?: (text: string) => void;
}) {
  const { t } = useLingui();
  const [items, setItems] = useState<ArtifactSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<"made" | "skills">("made");
  const [query, setQuery] = useState("");
  const [selectedKind, setSelectedKind] = useState<ArtifactKind | "all">("all");
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ArtifactSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setLoadError(null);
    setSelectedKind("all");

    async function load() {
      let cursor: string | undefined;
      let all: ArtifactSummary[] = [];
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await rpc.artifacts.listSpace({ botId, cursor, limit: LIST_PAGE_SIZE });
        if (cancelled) return;
        all = all.concat(result.items);
        setItems(all);
        if (!result.nextCursor) return;
        cursor = result.nextCursor;
      }
    }

    load().catch((error: unknown) => {
      if (cancelled) return;
      setItems((current) => current ?? []);
      setLoadError(error instanceof Error ? error.message : t`Could not load your Library.`);
    });

    return () => {
      cancelled = true;
    };
  }, [botId, t]);

  const facetCounts = useMemo(() => {
    const counts = new Map<ArtifactKind, number>();
    for (const item of items ?? []) {
      const kind = artifactKind(item.mimeType);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return counts;
  }, [items]);

  const filtered = useMemo(() => {
    if (!items) return null;
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      if (selectedKind !== "all" && artifactKind(item.mimeType) !== selectedKind) return false;
      if (!needle) return true;
      return (
        item.name.toLowerCase().includes(needle) ||
        (item.description?.toLowerCase().includes(needle) ?? false)
      );
    });
  }, [items, query, selectedKind]);

  async function handleDownload(item: ArtifactSummary) {
    try {
      const artifact = await rpc.artifacts.getById({ artifactId: item.id });
      downloadArtifactBytes(
        artifact.name,
        artifact.mimeType,
        decodeArtifactBase64(artifact.contentBase64),
      );
    } catch {
      // Best-effort; the person can try again from the card's "…" menu.
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await rpc.artifacts.remove({ artifactId: pendingDelete.id });
      setItems((current) => current?.filter((entry) => entry.id !== pendingDelete.id) ?? current);
      if (openArtifactId === pendingDelete.id) setOpenArtifactId(null);
      setPendingDelete(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : t`Could not delete this.`);
    } finally {
      setDeleteBusy(false);
    }
  }

  const total = items?.length ?? 0;
  const visibleKinds = KIND_ORDER.filter((kind) => (facetCounts.get(kind) ?? 0) > 0);

  return (
    <MuseScreen
      header={
        <ScreenHeader
          title={t`Library`}
          dragRegion
          actions={
            <>
              {view === "made" && total > 0 ? (
                <label className="relative hidden sm:block">
                  <Search
                    size={14}
                    strokeWidth={1.9}
                    aria-hidden="true"
                    className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-ink-3"
                  />
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t`Search your Library…`}
                    aria-label={t`Search your Library`}
                    className="nova-glass-pill h-8 w-[200px] rounded-full ps-8 pe-3 text-[13px] text-foreground outline-none placeholder:text-ink-3 focus-visible:outline-2 focus-visible:outline-ring"
                  />
                </label>
              ) : null}
              <SegmentedControl
                label={t`Library view`}
                value={view}
                onChange={setView}
                className="w-[200px]"
                options={[
                  { value: "made", label: t`Made for you` },
                  { value: "skills", label: t`Skills` },
                ]}
              />
            </>
          }
        />
      }
    >
      <MuseWideCenter className="min-h-full">
        <ScreenHero
          tile={
            <NovaTile tone="indigo" size={44}>
              <LibraryGlyph />
            </NovaTile>
          }
          title={<Trans>Library</Trans>}
          subtitle={view === "made" ? <Trans>Everything I made for you.</Trans> : undefined}
          action={
            view === "made" && total > 0 ? (
              <SegmentedControl
                label={t`Kind`}
                value={selectedKind}
                onChange={setSelectedKind}
                className="max-w-full"
                options={[
                  {
                    value: "all" as const,
                    label: (
                      <>
                        {t`All`} <Count n={total} />
                      </>
                    ),
                  },
                  ...visibleKinds.map((kind) => ({
                    value: kind,
                    label: (
                      <>
                        {kindFacetLabel(kind)} <Count n={facetCounts.get(kind) ?? 0} />
                      </>
                    ),
                  })),
                ]}
              />
            ) : undefined
          }
        />
        {view === "skills" ? (
          <SkillsPanel botId={botId} />
        ) : (
          <>
            {total > 0 ? (
              <label className="relative block sm:hidden">
                <Search
                  size={14}
                  strokeWidth={1.9}
                  aria-hidden="true"
                  className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-ink-3"
                />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t`Search your Library…`}
                  aria-label={t`Search your Library`}
                  className="h-9 w-full rounded-full bg-selection ps-8 pe-3 text-[13px] text-foreground outline-none placeholder:text-ink-3 focus-visible:outline-2 focus-visible:outline-ring"
                />
              </label>
            ) : null}

            {items === null ? (
              <LibrarySkeletonGrid />
            ) : items.length === 0 ? (
              loadError ? (
                <p className="py-10 text-[14px] text-destructive">{loadError}</p>
              ) : (
                <EmptyState
                  illustration="books"
                  headline={t`Nothing here yet.`}
                  suggestions={LIBRARY_SUGGESTIONS}
                  onSuggestion={onSendIdea}
                >
                  {t`Pages, documents and files your Muse makes will appear here.`}
                </EmptyState>
              )
            ) : filtered && filtered.length === 0 ? (
              <EmptyState headline={t`Nothing matches your search.`} />
            ) : (
              <LibraryGrid
                items={filtered ?? []}
                onOpen={(item) => setOpenArtifactId(item.id)}
                onDownload={(item) => void handleDownload(item)}
                onDelete={setPendingDelete}
              />
            )}
          </>
        )}
      </MuseWideCenter>

      {openArtifactId ? (
        <ArtifactPreviewDialog
          artifactId={openArtifactId}
          onOpenChange={(open) => {
            if (!open) setOpenArtifactId(null);
          }}
        />
      ) : null}

      {pendingDelete ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open && !deleteBusy) setPendingDelete(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <Trans>Delete "{pendingDelete.name}"?</Trans>
              </AlertDialogTitle>
              <AlertDialogDescription>
                {pendingDelete.versionCount > 1 ? (
                  <Trans>
                    This deletes all {pendingDelete.versionCount} versions of this. This can't be
                    undone.
                  </Trans>
                ) : (
                  <Trans>This can't be undone.</Trans>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {deleteError ? <p className="text-[13.5px] text-destructive">{deleteError}</p> : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleteBusy}>
                <Trans>Cancel</Trans>
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={deleteBusy}
                onClick={() => void confirmDelete()}
              >
                {deleteBusy ? <Trans>Deleting…</Trans> : <Trans>Delete</Trans>}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </MuseScreen>
  );
}
