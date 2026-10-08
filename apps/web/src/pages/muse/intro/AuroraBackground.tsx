import { DEFAULT_MUSE_COLOR } from "@nova/contracts";
import { useEffect, useRef } from "react";
import type * as ThreeNamespace from "three";
import { parseColor, supportsWebGL } from "../../../components/ai/webgl";

// A calm, living background for the Muse signed-out and first-run screens (docs/muse/DESIGN.md):
// a slow flowing gradient field, full-bleed and behind the content, drawn with a simplex-noise
// fragment shader on a full-screen plane. Colors are read from the resolved semantic CSS
// variables at runtime, plus the Muse's identity color as the only accent, so it stays correct
// in both themes without ever hardcoding a hex here. Three.js is loaded lazily (`import("three")`)
// so it stays a separate, code-split chunk fetched only on these screens.
//
// Falls back to a static CSS gradient (built only from the same semantic variables) when WebGL
// isn't available, and renders a single still frame under `prefers-reduced-motion: reduce`.

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const TARGET_FPS = 30;
const FRAME_BUDGET_MS = 1000 / TARGET_FPS;
const MAX_DEVICE_PIXEL_RATIO = 1.5;

const FALLBACK_BACKGROUND = [
  "radial-gradient(ellipse 70% 55% at 16% 10%, var(--muted), transparent 60%)",
  `radial-gradient(ellipse 60% 50% at 88% 92%, color-mix(in srgb, ${DEFAULT_MUSE_COLOR} 30%, var(--background)), transparent 65%)`,
  "radial-gradient(ellipse 90% 75% at 50% 45%, transparent 35%, var(--background) 82%)",
  "var(--background)",
].join(", ");

const VERTEX_SHADER = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
`;

const FRAGMENT_SHADER = `
varying vec2 vUv;
uniform float uTime;
uniform vec2 uResolution;
uniform vec2 uPointer;
uniform vec3 uColorBg;
uniform vec3 uColorMuted;
uniform vec3 uColorBorder;
uniform vec3 uColorFg;
uniform vec3 uColorAccent;

// Ashima Arts simplex noise (2D), public domain.
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                      -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    value += amplitude * snoise(p);
    p *= 2.0;
    amplitude *= 0.5;
  }
  return value;
}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
  p += uPointer * 0.02;

  float t = uTime * 0.03;
  float n1 = fbm(p * 1.1 + vec2(t, -t * 0.6));
  float n2 = fbm(p * 1.6 - vec2(-t * 0.5, t * 0.4) + 4.2);
  float flow = fbm(p * 0.8 + vec2(n1, n2) * 0.6 + t);

  vec3 color = uColorBg;
  color = mix(color, uColorMuted, smoothstep(-0.2, 0.6, n1) * 0.8);
  color = mix(color, uColorBorder, smoothstep(0.0, 0.8, n2) * 0.35);
  // Two aurora bands in the Muse color: a broad soft one and a brighter ribbon.
  color = mix(color, mix(uColorAccent, uColorBg, 0.45), smoothstep(0.05, 0.75, n2) * 0.45);
  color = mix(color, uColorAccent, smoothstep(0.3, 0.9, flow) * 0.38);
  color = mix(color, uColorFg, smoothstep(0.6, 1.0, n1 * n2) * 0.04);

  // Soft radial fade so the centered text column always reads against a calm field.
  float dist = length(vUv - 0.5);
  float vignette = smoothstep(0.12, 0.7, dist);
  color = mix(uColorBg, color, vignette * 0.55 + 0.45);

  gl_FragColor = vec4(color, 1.0);
}
`;

type ThemeColors = {
  background: [number, number, number];
  muted: [number, number, number];
  border: [number, number, number];
  foreground: [number, number, number];
  accent: [number, number, number];
};

function readThemeColors(): ThemeColors {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: [number, number, number]) =>
    parseColor(style.getPropertyValue(name), fallback);
  return {
    background: read("--background", [1, 1, 1]),
    muted: read("--muted", [0.94, 0.94, 0.93]),
    border: read("--border", [0.91, 0.91, 0.92]),
    foreground: read("--foreground", [0.08, 0.09, 0.1]),
    accent: parseColor(DEFAULT_MUSE_COLOR, [0, 0.56, 1]),
  };
}

/**
 * Full-bleed living background behind the Muse welcome, sign-in/up, and onboarding screens.
 * `pointer-events: none` and a negative z-index keep it purely decorative and behind content.
 */
export function AuroraBackground() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas || !supportsWebGL()) return;

    let disposed = false;
    let raf = 0;
    let lastFrameTime = 0;
    let renderer: ThreeNamespace.WebGLRenderer | null = null;
    let material: ThreeNamespace.ShaderMaterial | null = null;
    let geometry: ThreeNamespace.PlaneGeometry | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let themeObserver: MutationObserver | null = null;
    let cleanupThree: (() => void) | null = null;
    const pointer = { x: 0, y: 0 };

    function reduceMotion(): boolean {
      return window.matchMedia(REDUCED_MOTION_QUERY).matches;
    }

    function handlePointerMove(event: PointerEvent) {
      const rect = container?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return;
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = 1 - ((event.clientY - rect.top) / rect.height) * 2;
    }

    void import("three").then((THREE) => {
      if (disposed || !container || !canvas) return;

      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: false,
        powerPreference: "low-power",
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO));

      const scene = new THREE.Scene();
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const colors = readThemeColors();

      const uniforms = {
        uTime: { value: 6 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uPointer: { value: new THREE.Vector2(0, 0) },
        uColorBg: { value: new THREE.Color(...colors.background) },
        uColorMuted: { value: new THREE.Color(...colors.muted) },
        uColorBorder: { value: new THREE.Color(...colors.border) },
        uColorFg: { value: new THREE.Color(...colors.foreground) },
        uColorAccent: { value: new THREE.Color(...colors.accent) },
      };

      material = new THREE.ShaderMaterial({
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        depthTest: false,
        depthWrite: false,
        uniforms,
      });
      geometry = new THREE.PlaneGeometry(2, 2);
      scene.add(new THREE.Mesh(geometry, material));

      function resize() {
        if (!renderer || !container) return;
        const { clientWidth, clientHeight } = container;
        renderer.setSize(clientWidth, clientHeight, false);
        uniforms.uResolution.value.set(clientWidth, clientHeight);
      }
      resize();
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(container);

      function renderFrame(time: number) {
        if (!renderer) return;
        uniforms.uTime.value = 6 + time * 0.001;
        // Drift toward the pointer rather than following it: a slow ease keeps the wash calm.
        const current = uniforms.uPointer.value;
        current.set(
          current.x + (pointer.x - current.x) * 0.025,
          current.y + (pointer.y - current.y) * 0.025,
        );
        renderer.render(scene, camera);
      }

      function loop(time: number) {
        raf = window.requestAnimationFrame(loop);
        if (time - lastFrameTime < FRAME_BUDGET_MS) return;
        lastFrameTime = time;
        renderFrame(time);
      }

      function startLoop() {
        if (raf || reduceMotion()) return;
        lastFrameTime = 0;
        raf = window.requestAnimationFrame(loop);
      }

      function stopLoop() {
        if (!raf) return;
        window.cancelAnimationFrame(raf);
        raf = 0;
      }

      if (reduceMotion()) {
        renderFrame(0);
      } else {
        window.addEventListener("pointermove", handlePointerMove, { passive: true });
        startLoop();
      }

      function handleVisibility() {
        if (document.hidden) stopLoop();
        else startLoop();
      }
      document.addEventListener("visibilitychange", handleVisibility);

      themeObserver = new MutationObserver(() => {
        const next = readThemeColors();
        uniforms.uColorBg.value.setRGB(...next.background);
        uniforms.uColorMuted.value.setRGB(...next.muted);
        uniforms.uColorBorder.value.setRGB(...next.border);
        uniforms.uColorFg.value.setRGB(...next.foreground);
        uniforms.uColorAccent.value.setRGB(...next.accent);
        if (reduceMotion()) renderFrame(0);
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });

      cleanupThree = () => {
        stopLoop();
        window.removeEventListener("pointermove", handlePointerMove);
        document.removeEventListener("visibilitychange", handleVisibility);
      };
    });

    return () => {
      disposed = true;
      cleanupThree?.();
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      geometry?.dispose();
      material?.dispose();
      renderer?.dispose();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      data-testid="aurora-background"
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
      style={{ background: FALLBACK_BACKGROUND }}
    >
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}
