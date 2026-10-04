import { Skeleton } from "@aiden/ui-web";
import { LibraryCard } from "./LibraryCard";
import type { ArtifactSummary } from "./types";

export function LibraryGrid({
  items,
  onOpen,
  onDownload,
  onDelete,
}: {
  items: ArtifactSummary[];
  onOpen: (item: ArtifactSummary) => void;
  onDownload: (item: ArtifactSummary) => void;
  onDelete: (item: ArtifactSummary) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-5 pb-8 sm:grid-cols-2" data-testid="library-grid">
      {items.map((item) => (
        <LibraryCard
          key={item.id}
          artifact={item}
          onOpen={() => onOpen(item)}
          onDownload={() => onDownload(item)}
          onDelete={() => onDelete(item)}
        />
      ))}
    </div>
  );
}

const SKELETON_COUNT = 6;

export function LibrarySkeletonGrid() {
  return (
    <div
      className="grid grid-cols-1 gap-5 pb-8 sm:grid-cols-2"
      aria-hidden="true"
      data-testid="library-skeleton"
    >
      {Array.from({ length: SKELETON_COUNT }).map((_, index) => (
        <div key={index} className="flex flex-col overflow-hidden rounded-2xl border border-border">
          <Skeleton className="aspect-[16/10] w-full rounded-none" />
          <div className="flex flex-col gap-2 p-5">
            <Skeleton className="h-2.5 w-12 rounded-full" />
            <Skeleton className="h-4 w-3/4 rounded-full" />
            <Skeleton className="h-3 w-1/2 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
