import { cn } from "@nova/ui-web";
import { useEffect, useRef, useState } from "react";
import { SandboxedHtmlViewer } from "../../components/SandboxedHtmlViewer";
import { postDeckNavigation, readDeckEvent } from "./deck-model";

/** The deck's own fit() leaves a 32px margin, so a 1952x1112 frame lays the stage out at 1:1. */
const FRAME_W = 1952;
const FRAME_H = 1112;
export const THUMB_W = 116;
const SCALE = THUMB_W / FRAME_W;
const THUMB_H = Math.round(FRAME_H * SCALE);
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
}: {
  html: string;
  index: number;
  label: string;
  active: boolean;
  onSelect: (index: number) => void;
}) {
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
            "relative block overflow-hidden rounded-md bg-muted ring-1 ring-inset",
            active ? "ring-2 ring-foreground" : "ring-border group-hover:ring-foreground/40",
          )}
          style={{ width: THUMB_W, height: THUMB_H }}
        >
          {near ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute start-0 top-0 block origin-top-left"
              style={{ width: FRAME_W, height: FRAME_H, transform: `scale(${SCALE})` }}
            >
              <SandboxedHtmlViewer html={html} title={label} relay frameRef={frame} />
            </span>
          ) : null}
        </span>
        <span className="mt-1 flex items-baseline gap-1.5 text-[11px] text-muted-foreground">
          <span className="tabular-nums">{index + 1}</span>
          <span className="truncate">{label.replace(/^\d+\s*/, "")}</span>
        </span>
      </button>
    </div>
  );
}
