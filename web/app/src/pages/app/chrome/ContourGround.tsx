import { useEffect, useRef } from "react";

/** A peak the ground lifts under: an element in the same container marked `data-peak`. */
type Peak = { x: number; y: number; h: number; spread: number; hot: boolean };

/** How far a full peak lifts the lines, in px. */
const LIFT = 58;
/** The lines' resting opacity, and how far apart they lie (px). */
const LINE_ALPHA = 0.05;
const LINE_GAP = 30;
/** A peak eases toward its height by this share per frame (a new one rises from the ground). */
const EASE = 0.09;

/** `#rrggbb` / `rgb()` as its three channels (any CSS colour, via the canvas's own parser). */
function channels(ctx: CanvasRenderingContext2D, color: string, fallback: string): string {
  ctx.fillStyle = fallback;
  ctx.fillStyle = color || fallback;
  const value = String(ctx.fillStyle);
  if (value.startsWith("#") && value.length === 7) {
    return [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16)).join(",");
  }
  const match = /rgba?\(([^)]+)\)/.exec(value);
  return match?.[1]?.split(",").slice(0, 3).join(",") ?? "29,29,31";
}

/**
 * The ground's faint contour lines, behind everything. Where the container holds elements
 * marked `data-peak` (Home's topic cards), the lines lift into a peak under each one, higher for
 * a larger `data-peak-heat` (0 to 1) and highest, in the tint, under the one hovered or focused.
 * New peaks rise from the ground and the lines drift slowly while there are peaks; with reduced
 * motion they stand still and peaks appear at their height. Without peaks it draws once and
 * stays idle.
 */
export function ContourGround() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    // The container whose `data-peak` elements the ground lifts under (around the wrapper).
    const host = canvas?.parentElement?.parentElement;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !host || !ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const heights = new Map<string, number>();
    let width = 0;
    let height = 0;
    let frame = 0;
    let hot: string | null = null;
    let pointer: { x: number; y: number } | null = null;
    let peakCount = 0;

    const size = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const peaks = (): { list: Peak[]; settling: boolean } => {
      const base = canvas.getBoundingClientRect();
      const still = reduce.matches;
      let settling = false;
      const list: Peak[] = [];
      for (const el of host.querySelectorAll<HTMLElement>("[data-peak]")) {
        const key = el.dataset.peak ?? "";
        const r = el.getBoundingClientRect();
        const heat = Number(el.dataset.peakHeat ?? 0.5) || 0.5;
        const target = hot === key ? 1.9 : heat;
        const current = heights.get(key) ?? 0;
        const next = still ? target : current + (target - current) * EASE;
        if (Math.abs(target - next) > 0.002) settling = true;
        heights.set(key, next);
        list.push({
          x: r.left - base.left + r.width / 2,
          y: r.top - base.top + r.height * 0.62,
          h: next,
          spread: Math.max(90, r.width * 0.62),
          hot: hot === key,
        });
      }
      if (pointer && list.length) {
        list.push({
          x: pointer.x - base.left,
          y: pointer.y - base.top,
          h: 0.35,
          spread: 110,
          hot: false,
        });
      }
      return { list, settling };
    };

    /** Draws one frame; true while something still moves. */
    const draw = (now: number): boolean => {
      if (!width || !height) return false;
      const ink = channels(ctx, getComputedStyle(canvas).color, "#1d1d1f");
      const tint = channels(
        ctx,
        getComputedStyle(document.documentElement).getPropertyValue("--tint").trim(),
        "#0071e3",
      );
      ctx.clearRect(0, 0, width, height);
      const { list, settling } = peaks();
      const drift = reduce.matches || !list.length ? 0 : now * 0.00025;
      const count = Math.max(18, Math.round(height / LINE_GAP));
      const lit = list.find((p) => p.hot);
      let stroke: string | CanvasGradient = `rgba(${ink},${LINE_ALPHA})`;
      if (lit) {
        const glow = ctx.createRadialGradient(lit.x, lit.y, 0, lit.x, lit.y, lit.spread * 2.4);
        glow.addColorStop(0, `rgba(${tint},.55)`);
        glow.addColorStop(0.55, `rgba(${tint},.16)`);
        glow.addColorStop(1, `rgba(${ink},${LINE_ALPHA})`);
        stroke = glow;
      }
      for (let i = -3; i < count + 3; i++) {
        ctx.beginPath();
        for (let x = -20; x <= width + 20; x += 7) {
          const y0 = ((i + 0.5) * height) / count + (x / width) * height * 0.12 - height * 0.06;
          let dy =
            Math.sin(x * 0.0042 + drift + i * 0.7) * 5 + Math.sin(x * 0.011 - drift * 1.3 + i) * 2;
          for (const p of list) {
            const dx = x - p.x;
            const dz = y0 - p.y;
            dy -= p.h * LIFT * Math.exp(-(dx * dx + dz * dz * 1.6) / (2 * p.spread * p.spread));
          }
          if (x === -20) ctx.moveTo(x, y0 + dy);
          else ctx.lineTo(x, y0 + dy);
        }
        ctx.strokeStyle = stroke;
        ctx.lineWidth = lit ? 1.4 : 1.25;
        ctx.stroke();
      }
      // Summit rings: tighter and brighter the hotter the peak.
      for (const p of list) {
        if (p.spread === 110 && !p.hot) continue;
        for (let k = 1; k <= 3; k++) {
          ctx.beginPath();
          ctx.ellipse(
            p.x,
            p.y - p.h * 30,
            p.spread * 0.32 * k * (1.15 - p.h * 0.12),
            p.spread * 0.11 * k,
            0,
            0,
            Math.PI * 2,
          );
          ctx.strokeStyle = `rgba(${p.hot ? tint : ink},${((p.hot ? 0.22 : 0.05) * p.h) / k})`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
      return list.length > 0 && (!reduce.matches || settling);
    };

    const tick = (now: number) => {
      frame = 0;
      if (draw(now)) frame = requestAnimationFrame(tick);
    };
    const kick = () => {
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const peakOf = (target: EventTarget | null) =>
      target instanceof Element
        ? (target.closest<HTMLElement>("[data-peak]")?.dataset.peak ?? null)
        : null;
    const onMove = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
      hot = peakOf(event.target);
      kick();
    };
    const onLeave = () => {
      pointer = null;
      hot = null;
      kick();
    };
    const onFocus = (event: FocusEvent) => {
      hot = peakOf(event.target);
      kick();
    };

    size();
    kick();
    const resized = new ResizeObserver(() => {
      size();
      kick();
    });
    resized.observe(canvas);
    // Cards come and go (topics load, a range toggle): redraw only when the peaks changed.
    const changed = new MutationObserver(() => {
      const count = host.querySelectorAll("[data-peak]").length;
      if (count === peakCount) return;
      peakCount = count;
      kick();
    });
    changed.observe(host, { childList: true, subtree: true });
    const theme = new MutationObserver(kick);
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", kick);
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerleave", onLeave);
    host.addEventListener("focusin", onFocus);
    host.addEventListener("focusout", onLeave);
    host.addEventListener("scroll", kick, { passive: true });
    reduce.addEventListener("change", kick);
    return () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      changed.disconnect();
      theme.disconnect();
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
      host.removeEventListener("focusin", onFocus);
      host.removeEventListener("focusout", onLeave);
      host.removeEventListener("scroll", kick);
      reduce.removeEventListener("change", kick);
      scheme.removeEventListener("change", kick);
    };
  }, []);
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      <canvas ref={ref} className="size-full text-foreground" />
    </div>
  );
}
