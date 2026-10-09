import { cn } from "@nova/ui-web";
import { useEffect, useRef, useState } from "react";
import { SandboxedHtmlViewer } from "../../components/SandboxedHtmlViewer";
import { postDeckNavigation, readDeckEvent } from "./deck-model";

/** The deck's own fit() leaves a 32px margin, so a 1952x1112 frame lays the stage out at 1:1. */
const FRAME_W = 1952;
const FRAME_H = 1112;
export const THUMB_W = 116;
/** The slim rail's thumbnail: the same live frame, scaled down further. */
export const MINI_THUMB_W = 44;
const heightFor = (width: number) => Math.round((FRAME_H * width) / FRAME_W);
/** Without IntersectionObserver (tests) only the first few thumbnails mount. */
const FALLBACK_MOUNT = 6;

/** True while the element is near the viewport; thumbnails far from it do not hold a frame. */
function useNearViewport(index: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(
    typeof IntersectionObserver === "undefined" && index < FALLBACK_MOUNT,
  );
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setNear(entry.isIntersecting);
      },
      { rootMargin: "240px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, near };
}

/** One slide of the same sandboxed deck, live (not a screenshot), parked on its slide. */
export function DeckThumb({
  html,
  index,
  label,
  active,
  onSelect,
  compact = false,
}: {
  html: string;
  index: number;
  label: string;
  active: boolean;
  onSelect: (index: number) => void;
  /** A slim-rail thumbnail: smaller, with just its number under it. */
  compact?: boolean;
}) {
  const width = compact ? MINI_THUMB_W : THUMB_W;
  const scale = width / FRAME_W;
  const { ref, near } = useNearViewport(index);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!near) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      if (readDeckEvent(event.data)?.kind === "ready") {
        postDeckNavigation(frame.current?.contentWindow, { action: "go", index });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [near, index]);

  useEffect(() => {
    if (active) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [active, ref]);

  return (
    <div ref={ref}>
      <button
        type="button"
        role="option"
        aria-selected={active}
        aria-current={active ? "true" : undefined}
        aria-label={label || String(index + 1)}
        onClick={() => onSelect(index)}
        className={cn(
          "group block w-full text-start outline-none",
          "focus-visible:ring-2 focus-visible:ring-ring rounded-md",
        )}
      >
        <span
          className={cn(
            "relative block overflow-hidden rounded-[5px] bg-muted outline -outline-offset-1",
            active
              ? "outline-2 -outline-offset-2 outline-foreground"
              : "outline-1 outline-border group-hover:outline-foreground/40",
          )}
          style={{ width, height: heightFor(width) }}
        >
          {near ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute start-0 top-0 block origin-top-left"
              style={{ width: FRAME_W, height: FRAME_H, transform: `scale(${scale})` }}
            >
              <SandboxedHtmlViewer html={html} title={label} relay decorative frameRef={frame} />
            </span>
          ) : null}
        </span>
        {compact ? (
          <span
            className={cn(
              "mt-0.5 block text-center text-[10px] tabular-nums",
              active ? "font-semibold text-foreground" : "text-muted-foreground",
            )}
          >
            {index + 1}
          </span>
        ) : (
          <span className="mt-1 flex items-baseline gap-1.5 text-[11px] text-muted-foreground">
            <span className="tabular-nums">{index + 1}</span>
            <span className="truncate">{label.replace(/^\d+\s*/, "")}</span>
          </span>
        )}
      </button>
    </div>
  );
}
