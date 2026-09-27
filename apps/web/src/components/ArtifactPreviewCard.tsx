import { cn } from "@aiden/ui-web";
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
  testId,
}: {
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
}) {
  const [loaded, setLoaded] = useState(false);

  return (
    <div
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-2xl border border-border bg-card transition-[border-color,box-shadow,transform] duration-150 hover:border-ring/50 hover:shadow-float motion-safe:hover:-translate-y-0.5",
        size === "compact" && "w-[460px] max-w-full shrink-0",
      )}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label={buttonLabel}
        onClick={onOpen}
        data-testid={testId}
        className="flex flex-col text-start outline-none focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      >
        <div className="relative aspect-[16/10] w-full overflow-hidden bg-muted ring-1 ring-inset ring-border/50">
          <div
            aria-hidden="true"
            className={cn(
              "absolute inset-0 bg-muted transition-opacity duration-300 motion-safe:animate-pulse",
              loaded ? "opacity-0" : "opacity-100",
            )}
          />
          <div
            className={cn(
              "absolute inset-0 transition-opacity duration-300",
              loaded ? "opacity-100" : "opacity-0",
            )}
          >
            <ArtifactPreviewThumbnail artifact={artifact} onReady={() => setLoaded(true)} />
          </div>
        </div>
        <div className="border-t border-border px-4 py-3">
          <p className="truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">
            {title}
          </p>
          <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground">{meta}</p>
        </div>
      </button>
      {actions ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-end gap-1.5 p-2.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

/** Shared look for a small round frosted-glass action button; export it for triggers
 *  (e.g. a dropdown menu trigger) that need the same chrome but not `GlassAction`'s onClick. */
export const glassActionClassName =
  "pointer-events-auto grid size-8 shrink-0 place-items-center rounded-full border border-border/50 bg-card/80 text-muted-foreground shadow-sm backdrop-blur-md transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1";

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
