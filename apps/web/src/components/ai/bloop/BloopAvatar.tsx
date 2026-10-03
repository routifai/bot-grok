import {
  cn,
  type LiveMuseFaceProps,
  MUSE_FACE_CHEEK,
  MUSE_FACE_INK,
  MUSE_FACE_SHINE,
  MuseAvatar,
} from "@aiden/ui-web";
import { useEffect, useRef, useState } from "react";
import type { LiveBloopHandle } from "./live";

// The Muse's 3D face (docs/muse/DESIGN.md): a jelly drop whose expression follows the Muse state.
// It is supplied app-wide through `LiveMuseFaceProvider`, so every `BotAvatar face="muse"` uses
// it. The static SVG face and its Ask badge render first and stay as the fallback when WebGL is
// unavailable or the page already shows several live faces; the shared renderer (live.ts) loads
// lazily and the 3D face fades in over it once ready.

/** Below this size the thought cloud, spinner and "…" bubble would be unreadable specks. */
const PROPS_MIN_SIZE = 32;
const FACE_COLORS = { ink: MUSE_FACE_INK, cheek: MUSE_FACE_CHEEK, shine: MUSE_FACE_SHINE };

export function BloopAvatar({ color, size, state, waitingCount, className }: LiveMuseFaceProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<LiveBloopHandle | null>(null);
  const latest = useRef({ color, state, size });
  latest.current = { color, state, size };
  const [ready, setReady] = useState(false);
  const withProps = size >= PROPS_MIN_SIZE;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) return;
    let disposed = false;
    let acquiring = false;
    let observer: IntersectionObserver | null = null;

    // A face claims a live slot only once it is on screen, so a long list does not spend them all.
    function start() {
      if (acquiring || handleRef.current) return;
      acquiring = true;
      void import("./live").then(({ acquireLiveBloop }) =>
        acquireLiveBloop({
          canvas: canvas as HTMLCanvasElement,
          cssSize: latest.current.size,
          color: latest.current.color,
          state: latest.current.state,
          face: FACE_COLORS,
          withProps,
        }).then((handle) => {
          acquiring = false;
          if (!handle) return;
          if (disposed) {
            handle.release();
            return;
          }
          handleRef.current = handle;
          setReady(true);
        }),
      );
    }

    if (typeof IntersectionObserver === "undefined") {
      start();
    } else {
      observer = new IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        if (entry.isIntersecting) start();
        handleRef.current?.setVisible(entry.isIntersecting);
      });
      observer.observe(wrapper);
    }

    return () => {
      disposed = true;
      observer?.disconnect();
      handleRef.current?.release();
      handleRef.current = null;
      setReady(false);
    };
  }, [withProps]);

  useEffect(() => handleRef.current?.setState(state), [state]);
  useEffect(() => handleRef.current?.setColor(color), [color]);
  useEffect(() => handleRef.current?.resize(size), [size]);

  const scale = withProps ? 2.1 : 1.5;
  const canvasSize = Math.round(size * scale);
  return (
    <div
      ref={wrapperRef}
      data-bloop={ready ? "ready" : "loading"}
      className={cn("relative inline-flex shrink-0 items-center justify-center", className)}
      style={{ width: size, height: size }}
    >
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute start-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 transition-opacity duration-300 motion-reduce:transition-none",
          ready ? "opacity-100" : "opacity-0",
        )}
        style={{ width: canvasSize, height: canvasSize }}
      >
        <canvas ref={canvasRef} className="size-full" />
      </div>
      <MuseAvatar
        color={color}
        size={size}
        state={state}
        waitingCount={waitingCount}
        faceHidden={ready}
      />
    </div>
  );
}
