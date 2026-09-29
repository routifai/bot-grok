import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Measures a container's live rendered width so a chart can lay out at true 1:1 pixel
 * scale instead of stretching a fixed-size viewBox to fit — stretching shrinks the SVG's
 * text too (font-size is defined in viewBox units), which is why a chart sized for desktop
 * renders with unreadably small tick labels once squeezed into a phone-width column.
 */
export function useContainerWidth(
  fallback: number,
): readonly [(node: HTMLElement | null) => void, number] {
  const [width, setWidth] = useState(fallback);
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback(
    (node: HTMLElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!node) return;
      setWidth(Math.round(node.getBoundingClientRect().width) || fallback);
      if (typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) setWidth(Math.round(entry.contentRect.width));
      });
      observer.observe(node);
      observerRef.current = observer;
    },
    [fallback],
  );

  useEffect(() => () => observerRef.current?.disconnect(), []);
  return [ref, width] as const;
}
