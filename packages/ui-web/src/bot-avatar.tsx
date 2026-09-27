import type { MuseState } from "@rakazo/contracts";
import { DEFAULT_MUSE_COLOR } from "@rakazo/contracts";
import type { GrokColorDef } from "@rakazo/core";
import {
  ACTIVE_RUN_STATUSES,
  avatarIdentitySeed,
  DEFAULT_GROK_BOT_COLOR,
  GROK_BOT_COLORS,
  GROK_COLOR_LIST,
  organicAvatarPath,
  resolvePersonaColorDef,
  SHIPPED_BOT_AVATAR_CENTER,
  SHIPPED_BOT_AVATAR_SHAPE_KEYS,
  SHIPPED_BOT_AVATAR_SHAPES,
  SHIPPED_BOT_AVATAR_VIEWBOX,
  shippedBotAvatarShapePath,
  shippedHash,
} from "@rakazo/core";
import { tokens } from "@rakazo/ui-tokens";
import type { CSSProperties } from "react";
import { memo, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AvatarStyle } from "./avatar-style.js";
import { useAvatarStyle } from "./avatar-style.js";
import { cn } from "./lib/utils.js";
import { playLionRoar } from "./lion-roar.js";
import "./styles.css";

export type { GrokColorDef };
export { DEFAULT_GROK_BOT_COLOR, GROK_BOT_COLORS, GROK_COLOR_LIST, resolvePersonaColorDef };

export const GROK_SHAPES = SHIPPED_BOT_AVATAR_SHAPES;
export const SHIPPED_SHAPE_KEYS = SHIPPED_BOT_AVATAR_SHAPE_KEYS;
const VIEWBOX = SHIPPED_BOT_AVATAR_VIEWBOX;
const CENTER = SHIPPED_BOT_AVATAR_CENTER;

export const GROK_MASCOT_SHAPES = SHIPPED_SHAPE_KEYS.map(
  (k) => GROK_SHAPES[k] ?? FALLBACK_SHAPE_PATH,
);

const FALLBACK_SHAPE_PATH = GROK_SHAPES.hex ?? "";

export function resolvePersonaShape(identity: string, explicitShape?: string | null): string {
  if (explicitShape) {
    const explicit = GROK_SHAPES[explicitShape];
    if (explicit) return explicit;
  }
  let hash = shippedHash(identity);
  hash = Math.imul(hash ^ (hash >>> 16), 73244475);
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
  const shapeIndex = ((hash ^ (hash >>> 16)) >>> 0) % SHIPPED_SHAPE_KEYS.length;
  const key = SHIPPED_SHAPE_KEYS[shapeIndex] ?? "hex";
  return GROK_SHAPES[key] ?? FALLBACK_SHAPE_PATH;
}

export function parseBotAvatar(
  rawColor: string,
  _identity?: string,
): {
  color: string;
  shapeIndex?: number;
  isImage: boolean;
  imageUrl?: string;
} {
  if (!rawColor) return { color: "#F97316", isImage: false };
  // Only data: image URLs are rendered. Arbitrary http(s)/blob values in `color`
  // must not become <img src> (SSRF / tracking when other members view the bot).
  if (rawColor.startsWith("data:image/")) {
    return { color: "#F97316", isImage: true, imageUrl: rawColor };
  }
  if (rawColor.includes("::shape_")) {
    const parts = rawColor.split("::shape_");
    const rawShapeIdx = parts[1] ?? "0";
    const parsedShapeIdx = /^\d+$/.test(rawShapeIdx) ? Number(rawShapeIdx) : 0;
    const shapeIdx = Number.isSafeInteger(parsedShapeIdx) ? parsedShapeIdx : 0;
    return {
      color: parts[0] || "#F97316",
      shapeIndex: shapeIdx % SHIPPED_SHAPE_KEYS.length,
      isImage: false,
    };
  }
  return { color: rawColor, isImage: false };
}

export interface BotAvatarProps {
  color: string;
  size?: number;
  status?: string;
  identity?: string;
  className?: string;
  variant?: AvatarStyle;
  /** Renders the Muse face (Aiden the lion, docs/muse/DESIGN.md) instead of the shipped mascot shapes. */
  face?: "muse";
  /** Open-Ask count for the `waiting` Muse state; ignored unless `face="muse"`. */
  waitingCount?: number;
}

/**
 * `idle` / `working` / `waiting` are derived, never passed as free strings:
 * an open Ask always wins over an active run.
 */
export function museAvatarState(
  status: string | undefined,
  waitingCount: number | undefined,
): MuseState {
  if ((waitingCount ?? 0) > 0) return "waiting";
  if (ACTIVE_RUN_STATUSES.some((s) => s === status)) return "working";
  return "idle";
}

export const BotAvatar = memo(function BotAvatar({
  color,
  size = 36,
  status,
  identity = "",
  className,
  variant,
  face,
  waitingCount,
}: BotAvatarProps) {
  const id = useId().replace(/[^a-zA-Z0-9-_]/g, "");
  const isWorking = ACTIVE_RUN_STATUSES.some((s) => s === status);
  const preferredVariant = useAvatarStyle();

  const parsed = useMemo(() => parseBotAvatar(color, identity), [color, identity]);
  const effectiveId = identity || parsed.color || "agent";

  const colorDef = useMemo(
    () => resolvePersonaColorDef(effectiveId, parsed.color),
    [effectiveId, parsed.color],
  );

  const shapePath = useMemo(() => {
    if (parsed.shapeIndex !== undefined) {
      return shippedBotAvatarShapePath(parsed.shapeIndex);
    }
    return resolvePersonaShape(effectiveId);
  }, [parsed.shapeIndex, effectiveId]);

  if (parsed.isImage && parsed.imageUrl) {
    return (
      <div
        className={cn(
          "rakazo-bot-avatar relative overflow-hidden rounded-full flex items-center justify-center select-none bg-secondary shrink-0 border border-border",
          className,
        )}
        data-working={isWorking}
        style={{
          width: size,
          height: size,
          boxShadow: isWorking
            ? "0 0 0 2px #3B82F6, 0 0 10px rgba(59,130,246,0.6)"
            : "0 2px 5px rgba(0,0,0,0.5)",
        }}
      >
        {isWorking ? (
          <svg
            className="rakazo-bot-avatar-ring absolute pointer-events-none"
            style={{
              inset: -4,
              width: size + 8,
              height: size + 8,
            }}
            viewBox="0 0 48 48"
            fill="none"
            aria-hidden="true"
          >
            <circle
              cx="24"
              cy="24"
              r="22"
              stroke="#3B82F6"
              strokeWidth="3.2"
              strokeLinecap="round"
              strokeDasharray="45 80"
            />
          </svg>
        ) : null}
        <img src={parsed.imageUrl} alt="" className="h-full w-full object-cover" />
      </div>
    );
  }

  if (face === "muse") {
    return (
      <MuseAvatar
        color={color ? parsed.color : DEFAULT_MUSE_COLOR}
        size={size}
        state={museAvatarState(status, waitingCount)}
        waitingCount={waitingCount ?? 0}
        className={className}
      />
    );
  }

  if (parsed.shapeIndex === undefined && (variant ?? preferredVariant) === "organic") {
    return (
      <OrganicAvatar
        color={colorDef.hex}
        identity={effectiveId}
        size={size}
        isWorking={isWorking}
        className={className}
      />
    );
  }

  return (
    <div
      className={cn(
        "rakazo-bot-avatar grok-avatar-container relative inline-flex items-center justify-center shrink-0 select-none",
        className,
      )}
      style={{
        width: size,
        height: size,
      }}
      data-working={isWorking}
    >
      <svg
        className="rakazo-bot-avatar-ring absolute pointer-events-none"
        style={{
          inset: -4,
          width: size + 8,
          height: size + 8,
          filter: `drop-shadow(0 0 6px ${colorDef.light}) drop-shadow(0 0 10px #ffffff)`,
        }}
        viewBox="0 0 48 48"
        fill="none"
        aria-hidden="true"
      >
        <circle
          cx="24"
          cy="24"
          r="22"
          stroke={`url(#${id}-ring)`}
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeDasharray="45 80"
        />
        <circle cx="43" cy="24" r="2.8" fill="#ffffff" />
        <defs>
          <linearGradient id={`${id}-ring`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="60%" stopColor={colorDef.light} stopOpacity="0.9" />
            <stop offset="100%" stopColor={colorDef.light} stopOpacity="0" />
          </linearGradient>
        </defs>
      </svg>
      <svg
        viewBox={VIEWBOX}
        width={size}
        height={size}
        aria-hidden="true"
        className={cn(
          "overflow-visible transition-transform duration-300",
          isWorking
            ? "animate-pulse scale-[1.04] motion-reduce:animate-none"
            : "hover:scale-[1.03] motion-reduce:hover:scale-100",
        )}
        style={{
          filter: isWorking
            ? `drop-shadow(0 0 8px ${colorDef.light}) drop-shadow(0 0 2px #ffffff)`
            : "drop-shadow(0 2px 4px rgba(0,0,0,0.45))",
        }}
      >
        <defs>
          <linearGradient id={`grok-ink-${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={colorDef.light} />
            <stop offset="100%" stopColor={colorDef.dark} />
          </linearGradient>
        </defs>
        <g>
          <path d={shapePath} fill={`url(#grok-ink-${id})`} />
          <g fill={colorDef.eyeColor} className="grok-character-eyes">
            <ellipse cx={CENTER - 29} cy={CENTER - 8} rx={10} ry={7} />
            <ellipse cx={CENTER + 29} cy={CENTER - 8} rx={10} ry={7} />
          </g>
        </g>
      </svg>
    </div>
  );
});

function OrganicAvatar({
  color,
  identity,
  size,
  isWorking,
  className,
}: {
  color: string;
  identity?: string;
  size: number;
  isWorking: boolean;
  className?: string;
}) {
  const reducedMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    reducedMotionSnapshot,
    () => false,
  );
  const seed = avatarIdentitySeed(identity || color || DEFAULT_GROK_BOT_COLOR);
  const duration = `${4.8 + (seed % 24) / 10}s`;
  const shapeA = organicAvatarPath(seed);
  const shapeB = organicAvatarPath(seed, 0.42);

  return (
    <svg
      viewBox="-60 -60 120 120"
      aria-hidden="true"
      className={cn("rakazo-organic-avatar overflow-visible select-none", className)}
      data-working={isWorking}
      data-shape-family={seed % 10}
      data-eye-pattern={seed % 4}
      style={{
        width: size,
        height: size,
        flex: "none",
      }}
    >
      {(["idle", "working"] as const).map((mode) => (
        <path
          key={mode}
          className={`rakazo-organic-avatar-body rakazo-organic-avatar-body-${mode}`}
          d={shapeA}
          fill={color}
          style={
            {
              "--rakazo-organic-path": `path("${shapeA}")`,
              filter:
                mode === "working"
                  ? `drop-shadow(0 0 ${Math.round(size * 0.16)}px ${color})`
                  : "drop-shadow(0 2px 3px rgba(0,0,0,.34))",
            } as CSSProperties
          }
        >
          {!reducedMotion ? (
            <animate
              attributeName="d"
              values={`${shapeA};${shapeB};${shapeA}`}
              dur={duration}
              repeatCount="indefinite"
            />
          ) : null}
        </path>
      ))}
      <g transform={`rotate(${(seed % 9) - 4})`}>
        {(["idle", "working"] as const).map((mode) => (
          <g
            key={mode}
            className={`rakazo-organic-avatar-eyes rakazo-organic-avatar-eyes-${mode}`}
            fill={tokens.background}
          >
            <rect x="-14" y="-12" width="7" height="24" rx="3.5" />
            <rect x="7" y="-12" width="7" height="24" rx="3.5" />
          </g>
        ))}
      </g>
    </svg>
  );
}

/**
 * Fixed accents for the Muse face: Aiden, an original vinyl-toy lion (docs/muse/DESIGN.md).
 * The mane is the only part that takes the bot's identity color; everything else is part
 * of the illustration and defined once here.
 */
const MUSE_FACE_INK = "#161310";
const MUSE_FACE_HEAD = "#F2B55C";
const MUSE_FACE_HEAD_SHADE = "#E29A3E";
const MUSE_FACE_EAR_INNER = "#FBDDA6";
const MUSE_FACE_MUZZLE = "#FCE6BC";
const MUSE_FACE_MOUTH = "#7A2E2A";
const MUSE_FACE_TONGUE = "#FF8E86";
const MUSE_FACE_SHINE = "#FFFFFF";

/** One mane tuft: a teardrop pointing away from the head's center at (60, 62). */
function maneTuft(angle: number, radius: number, length: number, width: number): string {
  const cx = 60;
  const cy = 62;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const baseX = cx + radius * cos;
  const baseY = cy + radius * sin;
  // A slight clockwise sweep so the tufts read as hair, not petals.
  const tipAngle = angle + 0.22;
  const tipX = cx + (radius + length) * Math.cos(tipAngle);
  const tipY = cy + (radius + length) * Math.sin(tipAngle);
  const sideX = -sin * width;
  const sideY = cos * width;
  const f = (n: number) => n.toFixed(1);
  return (
    `M${f(baseX - sideX)} ${f(baseY - sideY)}` +
    `Q${f(tipX - sideX * 0.72)} ${f(tipY - sideY * 0.72)} ${f(tipX)} ${f(tipY)}` +
    `Q${f(tipX + sideX * 0.72)} ${f(tipY + sideY * 0.72)} ${f(baseX + sideX)} ${f(baseY + sideY)}Z`
  );
}

/** Two layers of tufts: a full outer ring and a lighter inner ring offset by half a tuft. */
const MUSE_MANE_OUTER = Array.from({ length: 14 }, (_, i) =>
  maneTuft((i / 14) * Math.PI * 2 - Math.PI / 2, 30, 25, 11),
).join("");
const MUSE_MANE_INNER = Array.from({ length: 14 }, (_, i) =>
  maneTuft(((i + 0.5) / 14) * Math.PI * 2 - Math.PI / 2, 29, 19, 10),
).join("");

/** How long a click roar lasts; matches the rakazo-muse-roar keyframes. */
const MUSE_ROAR_MS = 900;

/** Below this size a numeric waiting badge stops being legible; show a dot instead. */
const MUSE_BADGE_TEXT_MIN_SIZE = 32;

function MuseAvatar({
  color,
  size,
  state,
  waitingCount,
  className,
}: {
  color: string;
  size: number;
  state: MuseState;
  waitingCount: number;
  className?: string;
}) {
  const showBadge = waitingCount > 0;
  const showBadgeText = size >= MUSE_BADGE_TEXT_MIN_SIZE;
  const badgeLabel = waitingCount > 9 ? "9+" : String(waitingCount);
  const [roaring, setRoaring] = useState(false);
  const roarTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(roarTimer.current), []);

  // Clicking Aiden makes him roar. The click still reaches any surrounding button.
  const roar = () => {
    playLionRoar();
    setRoaring(true);
    clearTimeout(roarTimer.current);
    roarTimer.current = setTimeout(() => setRoaring(false), MUSE_ROAR_MS);
  };

  return (
    <div
      className={cn(
        "rakazo-muse-avatar-container relative inline-flex items-center justify-center shrink-0 select-none",
        className,
      )}
      style={{ width: size, height: size }}
      onPointerDown={roar}
    >
      <svg
        viewBox="0 0 120 120"
        width={size}
        height={size}
        aria-hidden="true"
        data-muse-state={state}
        data-roaring={roaring || undefined}
        className="rakazo-muse-avatar overflow-visible"
      >
        <ellipse cx={60} cy={115} rx={30} ry={3.5} fill={MUSE_FACE_INK} opacity={0.1} />
        <g className="rakazo-muse-all">
          <g className="rakazo-muse-mane">
            <path fill={color} d={MUSE_MANE_OUTER} />
            <path fill={MUSE_FACE_INK} opacity={0.14} d={MUSE_MANE_OUTER} />
            <path fill={color} d={MUSE_MANE_INNER} />
            <path fill={MUSE_FACE_SHINE} opacity={0.2} d={MUSE_MANE_INNER} />
          </g>
          <circle fill={MUSE_FACE_HEAD} cx={33} cy={34} r={11} />
          <circle fill={MUSE_FACE_HEAD} cx={87} cy={34} r={11} />
          <circle fill={MUSE_FACE_EAR_INNER} cx={33.5} cy={35} r={6.5} />
          <circle fill={MUSE_FACE_EAR_INNER} cx={86.5} cy={35} r={6.5} />
          <rect fill={MUSE_FACE_HEAD_SHADE} x={25} y={34} width={70} height={63} rx={29} />
          <rect fill={MUSE_FACE_HEAD} x={25} y={31} width={70} height={63} rx={29} />
          <ellipse
            fill={MUSE_FACE_SHINE}
            opacity={0.35}
            cx={42}
            cy={42}
            rx={10}
            ry={5}
            transform="rotate(-20 42 42)"
          />
          <g stroke={MUSE_FACE_HEAD_SHADE} strokeWidth={2.4} strokeLinecap="round" fill="none">
            <path d="M38 51Q44 48 50 50.5" />
            <path d="M70 50.5Q76 48 82 51" />
          </g>
          <g className="rakazo-muse-eyes">
            <g className="rakazo-muse-pupils">
              <circle fill={MUSE_FACE_INK} cx={45} cy={62} r={8.5} />
              <circle fill={MUSE_FACE_INK} cx={75} cy={62} r={8.5} />
              <circle fill={MUSE_FACE_SHINE} cx={48} cy={58.6} r={2.8} />
              <circle fill={MUSE_FACE_SHINE} cx={78} cy={58.6} r={2.8} />
            </g>
          </g>
          <ellipse fill={MUSE_FACE_MUZZLE} cx={60} cy={82} rx={16.5} ry={11.5} />
          <g className="rakazo-muse-mouth-closed">
            <path
              d="M60 80V83.5M51.5 84Q60 91 68.5 84"
              stroke={MUSE_FACE_INK}
              strokeWidth={2.2}
              strokeLinecap="round"
              fill="none"
            />
          </g>
          <g className="rakazo-muse-mouth-open">
            <ellipse fill={MUSE_FACE_MOUTH} cx={60} cy={88} rx={8} ry={7} />
            <ellipse fill={MUSE_FACE_TONGUE} cx={60} cy={92} rx={5} ry={2.6} />
          </g>
          <path fill={MUSE_FACE_INK} d="M53 74Q60 70.5 67 74Q64.5 79.5 60 80.5Q55.5 79.5 53 74Z" />
          <g fill={MUSE_FACE_INK} opacity={0.55}>
            <circle cx={49} cy={81} r={1} />
            <circle cx={50.5} cy={85} r={1} />
            <circle cx={71} cy={81} r={1} />
            <circle cx={69.5} cy={85} r={1} />
          </g>
        </g>
      </svg>
      {showBadge ? (
        showBadgeText ? (
          <span
            data-testid="muse-waiting-badge"
            className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-none font-semibold text-destructive-foreground"
          >
            {badgeLabel}
          </span>
        ) : (
          <span
            data-testid="muse-waiting-dot"
            className="absolute top-0 right-0 size-2 rounded-full bg-destructive"
          />
        )
      ) : null}
    </div>
  );
}

const reducedMotionMedia = "(prefers-reduced-motion: reduce)";

function reducedMotionSnapshot(): boolean {
  return window.matchMedia(reducedMotionMedia).matches;
}

function subscribeToReducedMotion(onChange: () => void): () => void {
  const media = window.matchMedia(reducedMotionMedia);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function GrokShapePreview({
  shapeIndex,
  color,
  selected,
  onClick,
}: {
  shapeIndex: number;
  color: string;
  selected?: boolean;
  onClick?: () => void;
}) {
  const key = SHIPPED_SHAPE_KEYS[shapeIndex % SHIPPED_SHAPE_KEYS.length] ?? "hex";
  const path = shippedBotAvatarShapePath(shapeIndex);
  const colorDef = resolvePersonaColorDef("preview", color);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={key}
      aria-pressed={selected ?? false}
      className={cn(
        "relative flex size-11 items-center justify-center rounded-xl transition-transform hover:scale-105 active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover",
        selected
          ? "ring-2 ring-primary ring-offset-2 ring-offset-popover bg-white/10"
          : "hover:bg-white/5",
      )}
    >
      <svg viewBox={VIEWBOX} className="size-8 overflow-visible" aria-hidden="true">
        <path d={path} fill={colorDef.light} />
        <g fill={colorDef.eyeColor}>
          <ellipse cx={CENTER - 29} cy={CENTER - 8} rx={10} ry={7} />
          <ellipse cx={CENTER + 29} cy={CENTER - 8} rx={10} ry={7} />
        </g>
      </svg>
    </button>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div className="flex h-11 w-11 items-center justify-center gap-1.5 rounded-full bg-card">
        <span className="h-4 w-[7px] rounded-full bg-primary" />
        <span className="h-4 w-[7px] rounded-full bg-primary" />
      </div>
      <span className="font-[Aeonik,ui-sans-serif] text-[28px] tracking-tight text-foreground">
        Rakazo
      </span>
    </div>
  );
}
