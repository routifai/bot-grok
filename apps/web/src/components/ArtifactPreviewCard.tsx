import { cn } from "@nova/ui-web";
import type { MouseEvent, ReactNode, RefObject } from "react";
import { useState } from "react";
import { ArtifactPreviewThumbnail, type PreviewableArtifact } from "./ArtifactPreviewThumbnail";

export type ArtifactPreviewCardSize = "compact" | "grid";

/**
 * The one artifact preview card — a finished-feeling piece of work being handed to you,
 * not a file-manager row. Shared by the Library grid (`size="grid"`, fills its cell) and
 * the chat file card (`size="compact"`, a fixed but responsive width): same radius,
 * hairline border, edge-to-edge preview with an overlay title/meta footer, and glass
 * actions that appear on hover/focus (always visible on touch).
 */
export function ArtifactPreviewCard({
  artifact,
  title,
  meta,
  size,
  buttonLabel,
  buttonRef,
  onOpen,
  actions,
  badge,
  fallback,
  testId,
}: {
  /** Art for a kind without a real preview (LibraryArt). */
  fallback?: ReactNode;
  artifact: PreviewableArtifact;
  title: string;
  meta: ReactNode;
  size: ArtifactPreviewCardSize;
  buttonLabel: string;
  buttonRef?: RefObject<HTMLButtonElement | null>;
  onOpen: () => void;
  /** Rendered top-right, over the preview; each action should be a small round glass button. */
  actions?: ReactNode;
  testId?: string;
  /** A small state marker pinned top-left over the preview (e.g. "Published"). */
  badge?: ReactNode;
}) {
  const [loaded, setLoaded] = useState(false);

  return (
    <div
      className={cn(
        "group relative flex min-w-0 flex-col",
        size === "compact" && "w-[460px] max-w-full shrink-0",
      )}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label={buttonLabel}
        onClick={onOpen}
        data-testid={testId}
        className="flex min-w-0 flex-col gap-2 rounded-[14px] text-start outline-none focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      >
        <div className="relative aspect-[4/3] w-full overflow-hidden rounded-[14px] bg-window ring-[0.5px] ring-separator ring-inset transition-transform duration-200 group-hover:-translate-y-0.5 motion-reduce:transition-none">
          <div
            aria-hidden="true"
            className={cn(
              "absolute inset-0 bg-window transition-opacity duration-300 motion-safe:animate-pulse",
              loaded ? "opacity-0" : "opacity-100",
            )}
          />
          <div
            className={cn(
              "absolute inset-0 transition-opacity duration-300",
              loaded ? "opacity-100" : "opacity-0",
            )}
          >
            <ArtifactPreviewThumbnail
              artifact={artifact}
              fallback={fallback}
              onReady={() => setLoaded(true)}
            />
          </div>
        </div>
        <div className="min-w-0 px-0.5">
          <p className="truncate text-[13px] font-semibold text-foreground" dir="auto">
            {title}
          </p>
          <p className="mt-0.5 truncate text-[12px] text-ink-3">{meta}</p>
        </div>
      </button>
      {badge ? (
        <div className="pointer-events-none absolute start-2 top-2 z-10">{badge}</div>
      ) : null}
      {actions ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-end gap-1.5 p-2 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

/** Shared look for a small round frosted-glass action button; export it for triggers
 *  (e.g. a dropdown menu trigger) that need the same chrome but not `GlassAction`'s onClick. */
export const glassActionClassName =
  "nova-glass-pill pointer-events-auto grid size-7 shrink-0 place-items-center rounded-full text-ink-2 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1";

/** A small round frosted-glass action button, meant to sit in `ArtifactPreviewCard`'s actions slot. */
export function GlassAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: (event: MouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick(event);
      }}
      className={glassActionClassName}
    >
      {children}
    </button>
  );
}
