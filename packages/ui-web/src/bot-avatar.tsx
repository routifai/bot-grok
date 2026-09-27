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
 * Aiden, the Muse (docs/muse/DESIGN.md): a head-and-shoulders crop of the Aiden mascot in a
 * round frame. The identity color draws the frame's ring and the roar ripples.
 */
export const AIDEN_HEAD_IMAGE = new URL("./assets/aiden-head.jpg", import.meta.url).href;
/** The full sitting Aiden, for large moments (welcome, onboarding). */
export const AIDEN_FULL_IMAGE = new URL("./assets/aiden-full.jpg", import.meta.url).href;

/** The full sitting Aiden for big moments; roars on click like the avatar. */
export function AidenHero({ size = 200, className }: { size?: number; className?: string }) {
  const [roaring, setRoaring] = useState(false);
  const roarTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(roarTimer.current), []);
  const roar = () => {
    playLionRoar();
    setRoaring(true);
    clearTimeout(roarTimer.current);
    roarTimer.current = setTimeout(() => setRoaring(false), MUSE_ROAR_MS);
  };
  return (
    <div
      className={cn("rakazo-muse-avatar-container relative shrink-0 select-none", className)}
      style={{ width: size, height: size }}
      onPointerDown={roar}
    >
      <div
        aria-hidden="true"
        data-muse-state="idle"
        data-roaring={roaring || undefined}
        className="rakazo-muse-avatar relative size-full"
      >
        <div className="rakazo-muse-all size-full overflow-hidden rounded-[28%] shadow-float">
          <img src={AIDEN_FULL_IMAGE} alt="" draggable={false} className="size-full object-cover" />
        </div>
      </div>
    </div>
  );
}

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
      <div
        aria-hidden="true"
        data-muse-state={state}
        data-roaring={roaring || undefined}
        className="rakazo-muse-avatar relative size-full"
        style={{ color }}
      >
        <span className="rakazo-muse-ripple" />
        <span className="rakazo-muse-ripple rakazo-muse-ripple-late" />
        <div
          className="rakazo-muse-all size-full overflow-hidden rounded-full"
          style={{ boxShadow: `0 0 0 ${size >= 48 ? 3 : 2}px ${color}` }}
        >
          <img src={AIDEN_HEAD_IMAGE} alt="" draggable={false} className="size-full object-cover" />
        </div>
      </div>
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
