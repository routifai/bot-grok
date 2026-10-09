import { useLingui } from "@lingui/react/macro";
import type { KnowledgeFileState } from "@nova/contracts";
import { cn } from "@nova/ui-web";
import { useKnowledgeFile } from "./status";

/** Where a file is in the index, as a Library card badge: reading it, searchable, or couldn't
 * be read. Nothing at all for a file the index doesn't hold. */
export function IndexBadge({ artifactId }: { artifactId: string }) {
  const { t } = useLingui();
  const file = useKnowledgeFile(artifactId);
  if (!file) return null;
  const label: Record<KnowledgeFileState, string> = {
    indexing: t`Indexing…`,
    searchable: t`Searchable`,
    failed: t`Couldn't index`,
  };
  return (
    <span
      data-testid="library-card-index"
      data-state={file.state}
      className="nova-glass-pill inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium text-ink-2"
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          file.state === "searchable" && "bg-success",
          file.state === "failed" && "bg-destructive",
          file.state === "indexing" && "animate-pulse bg-muted-foreground",
        )}
      />
      {label[file.state]}
    </span>
  );
}
