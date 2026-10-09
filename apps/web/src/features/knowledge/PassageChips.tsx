import { useLingui } from "@lingui/react/macro";
import type { ReplyCardDataOf } from "@nova/contracts";
import { FileText } from "lucide-react";
import { useEffect, useState } from "react";
import { useArtifactPanel } from "../../components/cards/context";
import { rpc } from "../../lib/rpc";

const thumbnails = new Map<string, Promise<string | null>>();

/** A page's thumbnail as a data URL, fetched once per page for the life of the tab. */
function loadThumbnail(artifactId: string, page: number): Promise<string | null> {
  const key = `${artifactId}:${page}`;
  let found = thumbnails.get(key);
  if (!found) {
    found = rpc.knowledge
      .pageThumbnail({ artifactId, page })
      .then((thumb) => `data:${thumb.mimeType};base64,${thumb.contentBase64}`)
      .catch(() => {
        thumbnails.delete(key);
        return null;
      });
    thumbnails.set(key, found);
  }
  return found;
}

/** Test seam: forget the cached thumbnails. */
export function resetThumbnailCache() {
  thumbnails.clear();
}

function Thumbnail({ artifactId, page }: { artifactId: string; page: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void loadThumbnail(artifactId, page).then((url) => {
      if (live) setSrc(url);
    });
    return () => {
      live = false;
    };
  }, [artifactId, page]);
  return src ? (
    <img src={src} alt="" className="size-full object-cover object-top" />
  ) : (
    <span className="size-full animate-pulse bg-muted" />
  );
}

/** The pages a search found, as small page-thumbnail chips under the answer. A chip opens the
 * file at that page in the side panel. */
export function PassageChips({ data }: { data: ReplyCardDataOf<"passages"> }) {
  const { t } = useLingui();
  const panel = useArtifactPanel();
  return (
    <ul data-testid="passage-chips" className="flex max-w-full flex-wrap gap-2">
      {data.items.map((item) => (
        <li key={`${item.artifactId}:${item.page}`} className="min-w-0">
          <button
            type="button"
            disabled={!panel}
            onClick={() => panel?.open(item.artifactId, item.name, item.page)}
            aria-label={t`Open ${item.name}, page ${item.page}`}
            className="nova-glass-pill flex max-w-[15rem] items-center gap-2 rounded-xl p-1 pe-3 text-start outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
          >
            <span className="grid h-11 w-9 shrink-0 place-items-center overflow-hidden rounded-md bg-card ring-1 ring-border">
              {item.hasThumbnail ? (
                <Thumbnail artifactId={item.artifactId} page={item.page} />
              ) : (
                <FileText size={15} className="text-muted-foreground" />
              )}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[12px] font-medium text-foreground" dir="auto">
                {item.name}
              </span>
              <span className="block text-[11px] text-muted-foreground tabular-nums">
                {t`p. ${item.page}`}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
