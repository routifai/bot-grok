import type { RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { artifactKind, KIND_ICON } from "../lib/artifact-kind";
import { decodeArtifactBase64 } from "../lib/artifact-open";
import { rpc } from "../lib/rpc";
import { useObjectUrl } from "../lib/use-object-url";
import { SandboxedHtmlViewer } from "./SandboxedHtmlViewer";

// A real preview is only cheap for images and small pages, so cap both the mime
// types and the byte size that get one; everything else keeps its type icon.
const HTML_PREVIEW_MAX_BYTES = 200_000;
const IMAGE_PREVIEW_MAX_BYTES = 3_000_000;

const bytesCache = new Map<string, Uint8Array>();

/** The minimum an artifact card needs to render (and lazily fetch) a preview thumbnail. */
export type PreviewableArtifact = {
  id: string;
  mimeType: string;
  size: number;
  name: string;
  /** Included when known, so an edited artifact's cached bytes don't stick around under the same id. */
  version?: number;
};

function cacheKey(artifact: PreviewableArtifact): string {
  return artifact.version !== undefined ? `${artifact.id}:${artifact.version}` : artifact.id;
}

/**
 * True once the element has scrolled near the viewport. Stays false forever where
 * `IntersectionObserver` isn't available (some test environments), which just means
 * that thumbnail keeps showing its type icon instead of guessing at visibility.
 */
function useNearViewport(): [RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, near];
}

/**
 * The one artifact preview thumbnail, shared by the Library grid and the Conversation
 * transcript's file cards. Fetches real content lazily — only once the thumbnail is
 * about to scroll into view, and only for images and small HTML pages — so a long list
 * or transcript never pulls every artifact's full bytes at once. PDFs, decks, larger
 * pages, and anything still off-screen show their type icon instead.
 */
export function ArtifactPreviewThumbnail({ artifact }: { artifact: PreviewableArtifact }) {
  const kind = artifactKind(artifact.mimeType);
  const [ref, near] = useNearViewport();
  const eligible =
    (kind === "image" && artifact.size <= IMAGE_PREVIEW_MAX_BYTES) ||
    (kind === "page" && artifact.size <= HTML_PREVIEW_MAX_BYTES);
  const [bytes, setBytes] = useState<Uint8Array | null>(
    () => bytesCache.get(cacheKey(artifact)) ?? null,
  );

  useEffect(() => {
    if (!eligible || !near || bytes) return;
    let cancelled = false;
    void rpc.artifacts
      .getById({ artifactId: artifact.id })
      .then((full) => {
        if (cancelled) return;
        const decoded = decodeArtifactBase64(full.contentBase64);
        bytesCache.set(cacheKey(artifact), decoded);
        setBytes(decoded);
      })
      .catch(() => {
        // Best-effort thumbnail; the type icon stays as the fallback.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, near, bytes, artifact.id]);

  const Icon = KIND_ICON[kind];

  return (
    <div ref={ref} className="grid h-full w-full place-items-center">
      {bytes && kind === "image" ? (
        <ImageThumbnail bytes={bytes} mimeType={artifact.mimeType} />
      ) : bytes && kind === "page" ? (
        <ScaledHtmlThumbnail bytes={bytes} title={artifact.name} />
      ) : (
        <Icon size={36} strokeWidth={1.5} className="text-muted-foreground/50" />
      )}
    </div>
  );
}

function ImageThumbnail({ bytes, mimeType }: { bytes: Uint8Array; mimeType: string }) {
  const url = useObjectUrl(bytes, mimeType);
  if (!url) return null;
  return <img src={url} alt="" className="h-full w-full object-cover" />;
}

function ScaledHtmlThumbnail({ bytes, title }: { bytes: Uint8Array; title: string }) {
  const html = useMemo(() => new TextDecoder("utf-8").decode(bytes), [bytes]);
  return (
    <div className="pointer-events-none h-full w-full overflow-hidden">
      <div className="h-[400%] w-[400%] origin-top-left scale-[0.25]">
        <SandboxedHtmlViewer html={html} title={title} />
      </div>
    </div>
  );
}
