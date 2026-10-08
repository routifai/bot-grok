import { type RefObject, useEffect, useRef, useState } from "react";

/** `prefers-reduced-motion: reduce`, read once on mount (like the page's own scripts did). */
export function usePrefersReducedMotion(): boolean {
  const [reduce] = useState(
    () =>
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  return reduce;
}

/**
 * Runs `onChange` once now, then on every scroll of the page's scroll container and on resize.
 * The page scrolls inside its own container, so `window` never fires.
 */
export function useScrollEffect(scrollRef: RefObject<HTMLElement | null>, onChange: () => void) {
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });
  useEffect(() => {
    const el = scrollRef.current;
    const run = () => latest.current();
    el?.addEventListener("scroll", run, { passive: true });
    window.addEventListener("resize", run);
    run();
    return () => {
      el?.removeEventListener("scroll", run);
      window.removeEventListener("resize", run);
    };
  }, [scrollRef]);
}

export type Later = (ms: number, fn: () => void) => void;

export type Script = {
  /** Schedule the demo's beats with `later`; every timer is cleared on reset or unmount. */
  play: (later: Later) => void;
  /** Reduced motion: jump to the finished state. */
  showAll: () => void;
  /** Back to the empty state. */
  reset: () => void;
};

/** Plays a demo each time its card comes to the front, and resets it when the card leaves. */
export function usePlayback(active: boolean, script: Script) {
  const reduce = usePrefersReducedMotion();
  const latest = useRef(script);
  useEffect(() => {
    latest.current = script;
  });
  useEffect(() => {
    const s = latest.current;
    s.reset();
    if (!active) return;
    if (reduce) {
      s.showAll();
      return;
    }
    const ids: number[] = [];
    s.play((ms, fn) => {
      ids.push(window.setTimeout(fn, ms));
    });
    return () => {
      for (const id of ids) window.clearTimeout(id);
    };
  }, [active, reduce]);
}
