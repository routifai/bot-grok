import { type RefObject, useEffect, useRef } from "react";

const COUNT = 220;
const DEPTH = 3; // the field is three screens tall and wraps

type Star = { x: number; y: number; z: number; a: number };

function makeStars(): Star[] {
  let s = 9;
  const r = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  return Array.from({ length: COUNT }, () => ({
    x: r(),
    y: r() * DEPTH,
    z: 0.2 + r() * 0.8,
    a: 0.2 + r() * 0.6,
  }));
}

/** A fixed star field that drifts with the scroll of the page's own scroll container. */
export function Stars({ scrollRef }: { scrollRef: RefObject<HTMLElement | null> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const scroller = scrollRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !scroller || !ctx) return;
    const color =
      getComputedStyle(scroller).getPropertyValue("--welcome-night-star").trim() || "white";
    const stars = makeStars();
    const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

    const draw = () => {
      const d = dpr();
      const h = window.innerHeight;
      const y = scroller.scrollTop;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = color;
      for (const st of stars) {
        const py = (((st.y * h - y * st.z * 0.35) % (h * DEPTH)) + h * DEPTH) % (h * DEPTH);
        if (py > h) continue;
        ctx.globalAlpha = st.a * 0.8;
        ctx.beginPath();
        ctx.arc(st.x * canvas.width, py * d, st.z * 1.3 * d, 0, 7);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };
    const size = () => {
      canvas.width = window.innerWidth * dpr();
      canvas.height = window.innerHeight * dpr();
      draw();
    };

    size();
    scroller.addEventListener("scroll", draw, { passive: true });
    window.addEventListener("resize", size);
    return () => {
      scroller.removeEventListener("scroll", draw);
      window.removeEventListener("resize", size);
    };
  }, [scrollRef]);

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0">
      <canvas ref={canvasRef} className="size-full" />
    </div>
  );
}
