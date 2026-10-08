import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** True once the element has reached the screen (once, never un-set). Reduced motion or `immediate`: at once. */
export function useReveal<T extends Element>(margin = "0px 0px -18% 0px", immediate = false) {
  const ref = useRef<T>(null);
  const [shown, setShown] = useState(() => immediate || prefersReducedMotion());
  useEffect(() => {
    const el = ref.current;
    if (shown || !el || typeof IntersectionObserver !== "function") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: margin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown, margin]);
  return [ref, shown] as const;
}

const ShownContext = createContext(false);
export const useShown = () => useContext(ShownContext);

/** Wrapper that reveals its `R` children, staggered, once it is on screen. */
export function Reveal({
  as: Tag = "div",
  className,
  immediate,
  children,
  ...rest
}: {
  as?: "div" | "section";
  className?: string;
  immediate?: boolean;
  children: ReactNode;
  [key: `data-${string}`]: string | undefined;
}) {
  const [ref, shown] = useReveal<HTMLDivElement>(undefined, immediate);
  return (
    <ShownContext.Provider value={shown}>
      <Tag
        ref={ref as never}
        className={`group ${className ?? ""}`}
        data-in={shown ? "true" : "false"}
        {...rest}
      >
        {children}
      </Tag>
    </ShownContext.Provider>
  );
}

/** One revealed child: fades up, delayed by its place in the beat. */
export function R({
  i,
  className = "",
  children,
}: {
  i: number;
  className?: string;
  children: ReactNode;
}) {
  const shown = useShown();
  return (
    <div
      className={`transition-[opacity,transform] duration-[550ms] ease-out motion-reduce:transition-none ${
        shown ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"
      } ${className}`}
      style={{ transitionDelay: shown ? `${(i + 1) * 350}ms` : "0ms" }}
    >
      {children}
    </div>
  );
}
