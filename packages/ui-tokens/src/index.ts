export const APPEARANCE_PREFERENCES = ["system", "light", "dark"] as const;

export type AppearancePreference = (typeof APPEARANCE_PREFERENCES)[number];

export type ResolvedAppearance = "light" | "dark";

export const UI_APPEARANCE_STORAGE_KEY = "aiden.uiAppearance";

/**
 * Semantic palette shared by web, Electron, and Expo. Names follow the shadcn
 * convention so the same slot means the same thing on every surface: a `border`
 * is always a border and never a fill.
 */
export type ColorTokens = {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  chatUser: string;
  chatUserForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
  sidebar: string;
  sidebarForeground: string;
  sidebarBorder: string;
  sidebarAccent: string;
  sidebarAccentForeground: string;
  link: string;
  success: string;
  warning: string;
  overlay: string;
  scrollbar: string;
  scrollbarHover: string;
  /** Muse only: the ground the shell's panels float on. */
  ground?: string;
  /** Muse only: the ground's single soft radial wash, top right. */
  "ground-wash"?: string;
  /** Muse only: a floating panel's translucent fill (rail, chat, context panel). */
  panel?: string;
  /** Muse only: an opaque surface on a panel (composer, popovers, cards). */
  solid?: string;
  /** Muse only: every hairline: panel edges, dividers, the composer's border. */
  line?: string;
  /** Muse only: primary text. */
  ink?: string;
  /** Muse only: secondary text and icons. */
  "ink-2"?: string;
  /** Muse only: faint text: placeholders, counts, timestamps. */
  "ink-3"?: string;
  /** Muse only: the person's message bubble. */
  bubble?: string;
  /** Muse only: the selected or hovered row. */
  selection?: string;
  /** Muse only: side-chat (fork) identity colors, one per fork, cycled. */
  "fork-1"?: string;
  "fork-2"?: string;
  "fork-3"?: string;
  "fork-4"?: string;
  "fork-5"?: string;
  "fork-6"?: string;
  /** Muse only: the ground the content window sits on. */
  window?: string;
  /** Muse only: the rounded content window. */
  content?: string;
  /** Muse only: a floating glass panel's translucent fill (sidebar, inspector). */
  glass?: string;
  /** Muse only: a glass panel's half-pixel edge. */
  "glass-line"?: string;
  /** Muse only: an inset grouped list or card. */
  group?: string;
  /** Muse only: inset hairlines between rows. */
  separator?: string;
  /** Muse only: a soft accent fill. */
  "selection-strong"?: string;
  /** Muse only: the accent: the primary action, the selected row, the person's bubble. */
  tint?: string;
  /** Muse only: accent text on a soft accent fill. */
  "tint-ink"?: string;
  /** Muse only: live / done dot. */
  ok?: string;
  /** Muse only: waiting dot. */
  warn?: string;
  /** Muse only: the red count badge. */
  alert?: string;
  /** Muse only: section signature color. */
  "sig-goals"?: string;
  /** Muse only: section signature color. */
  "sig-feed"?: string;
  /** Muse only: section signature color. */
  "sig-ideas"?: string;
  /** Muse only: section signature color. */
  "sig-library"?: string;
  /** Muse only: section signature color. */
  "sig-waiting"?: string;
  /** Muse only: section signature color. */
  "sig-forks"?: string;
  /** Muse only: Apple tile gradient stop. */
  "tile-blue-from"?: string;
  /** Muse only: Apple tile gradient stop. */
  "tile-blue-to"?: string;
  /** Muse only: Apple tile gradient stop. */
  "tile-green-from"?: string;
  /** Muse only: Apple tile gradient stop. */
  "tile-green-to"?: string;
  /** Muse only: Apple tile gradient stop. */
  "tile-yellow-from"?: string;
  /** Muse only: Apple tile gradient stop. */
  "tile-yellow-to"?: string;
  /** Muse only: Apple tile gradient stop. */
  "tile-orange-from"?: string;
  /** Muse only: Apple tile gradient stop. */
  "tile-orange-to"?: string;
  /** Muse only: Apple tile gradient stop. */
  "tile-purple-from"?: string;
  /** Muse only: Apple tile gradient stop. */
  "tile-purple-to"?: string;
  /** Muse only: Apple tile gradient stop. */
  "tile-red-from"?: string;
  /** Muse only: Apple tile gradient stop. */
  "tile-red-to"?: string;
  /** Muse only: Apple tile gradient stop. */
  "tile-indigo-from"?: string;
  /** Muse only: Apple tile gradient stop. */
  "tile-indigo-to"?: string;
  /** Muse only: Apple tile gradient stop. */
  "tile-teal-from"?: string;
  /** Muse only: Apple tile gradient stop. */
  "tile-teal-to"?: string;
  /** Muse only: Apple tile gradient stop. */
  "tile-gray-from"?: string;
  /** Muse only: Apple tile gradient stop. */
  "tile-gray-to"?: string;
  /** Muse only: the dark result tile. */
  media?: string;
  /** Muse only: the dark result tile. */
  "media-deep"?: string;
  /** Muse only: the dark result tile. */
  "media-glow"?: string;
  /** Muse only: the dark result tile. */
  "media-bar"?: string;
  /** Muse only: the dark result tile. */
  "media-bar-2"?: string;
  /** Muse only: the dark result tile. */
  "media-key-from"?: string;
  /** Muse only: the dark result tile. */
  "media-key-to"?: string;
  /** Muse only: a Feed media tile's glow. */
  "media-warm-glow"?: string;
  /** Muse only: a Feed media tile's glow. */
  "media-warm-deep"?: string;
  /** Muse only: a Feed media tile's glow. */
  "media-pink-glow"?: string;
  /** Muse only: a Feed media tile's glow. */
  "media-pink-deep"?: string;
  /** Muse only: a Feed media tile's glow. */
  "media-green-glow"?: string;
  /** Muse only: a Feed media tile's glow. */
  "media-green-deep"?: string;
};

export const darkTokens = {
  background: "#0B0C0E",
  foreground: "#ECECEE",
  card: "#141518",
  cardForeground: "#ECECEE",
  popover: "#141518",
  popoverForeground: "#ECECEE",
  primary: "#F1F1EF",
  primaryForeground: "#0B0C0E",
  secondary: "#18191E",
  secondaryForeground: "#ECECEE",
  chatUser: "#22242B",
  chatUserForeground: "#ECECEE",
  muted: "#141518",
  mutedForeground: "#85858A",
  accent: "#1A1B20",
  accentForeground: "#ECECEE",
  destructive: "#EF4444",
  destructiveForeground: "#FFFFFF",
  border: "#1E2026",
  input: "#18191E",
  ring: "#3B82F6",
  sidebar: "#111215",
  sidebarForeground: "#ECECEE",
  sidebarBorder: "#1C1D22",
  sidebarAccent: "#1A1B20",
  sidebarAccentForeground: "#ECECEE",
  link: "#3B82F6",
  success: "#4ECB71",
  warning: "#E9C46A",
  overlay: "rgba(4, 4, 5, 0.72)",
  scrollbar: "#1E2026",
  scrollbarHover: "#2E313A",
} as const satisfies ColorTokens;

export const lightTokens = {
  background: "#FAFAF8",
  foreground: "#1A1A1A",
  card: "#FFFFFF",
  cardForeground: "#1A1A1A",
  popover: "#FFFFFF",
  popoverForeground: "#1A1A1A",
  primary: "#1A1A1A",
  primaryForeground: "#F1F1EF",
  secondary: "#F0F0ED",
  secondaryForeground: "#1A1A1A",
  chatUser: "#E2E2DC",
  chatUserForeground: "#1A1A1A",
  muted: "#F0F0ED",
  mutedForeground: "#6C6C70",
  accent: "#EAEAE6",
  accentForeground: "#1A1A1A",
  destructive: "#DC2626",
  destructiveForeground: "#FFFFFF",
  border: "#F0F0ED",
  input: "#EAEAE6",
  ring: "#6C6C70",
  sidebar: "#ECECE9",
  sidebarForeground: "#1A1A1A",
  sidebarBorder: "#E8E8E4",
  sidebarAccent: "#FFFFFF",
  sidebarAccentForeground: "#1A1A1A",
  link: "#2563EB",
  success: "#228B3B",
  warning: "#B7791F",
  overlay: "rgba(20, 20, 22, 0.45)",
  scrollbar: "#C8C8C4",
  scrollbarHover: "#A8A8A4",
} as const satisfies ColorTokens;

/**
 * Nova's surfaces (docs/muse/DESIGN.md): a Mac app. The content sits in one rounded
 * `content` window on the `window` ground; the sidebar and inspector float inside it as
 * blurred `glass` panels with a half-pixel `glass-line`; iOS inset grouped lists sit on
 * `group`. Ink comes in three strengths, hairlines are `separator`. The Muse palettes below
 * map the shadcn slots onto these same values, so each color is written once. `background`
 * is the solid surface (shadcn controls paint it inside panels).
 *
 * Owner-approved exceptions to the monochrome rule (Apple Mac-app redesign): the `tint`
 * accent (the one primary action, the selected row, the person's bubble), the colored app
 * `tile-*` gradients, one signature color per section (`sig-*`), the red `alert` badge, the
 * dark `media-*` result tile, and `fork-*` (each side chat (fork) keeps one color in the
 * rail, the transcript and its own view).
 *
 * `ground`, `panel`, `solid`, `line`, `bubble` and `selection` are the older names the
 * screens still read; they now resolve to the window, glass, group, separator and fill.
 */
const tiles = {
  "tile-blue-from": "#3F9BFF",
  "tile-blue-to": "#0A7AFF",
  "tile-green-from": "#45D36C",
  "tile-green-to": "#2FB34F",
  "tile-yellow-from": "#FFD23F",
  "tile-yellow-to": "#FBB72C",
  "tile-orange-from": "#FFA63D",
  "tile-orange-to": "#FF8A00",
  "tile-purple-from": "#C977F0",
  "tile-purple-to": "#A347D6",
  "tile-red-from": "#FF6961",
  "tile-red-to": "#FF3B30",
  "tile-indigo-from": "#7D7AFF",
  "tile-indigo-to": "#5856D6",
  "tile-teal-from": "#5BD2E6",
  "tile-teal-to": "#30B0C7",
  "tile-gray-from": "#A1A1A6",
  "tile-gray-to": "#8E8E93",
  // The result tile (Conversation): a dark card with a blue glow, the same in both themes.
  media: "#000000",
  "media-deep": "#071A3D",
  "media-glow": "#0B3D91",
  "media-bar": "#2C2C2E",
  "media-bar-2": "#1C1C1E",
  "media-key-from": "#7FD4FF",
  "media-key-to": "#0060DF",
  // The Feed's other media tiles: warm, pink and green glows.
  "media-warm-glow": "#B25B00",
  "media-warm-deep": "#4A2300",
  "media-pink-glow": "#C21F54",
  "media-pink-deep": "#4B0B22",
  "media-green-glow": "#1F8F4A",
  "media-green-deep": "#0B3A1F",
} as const;

const novaLight = {
  window: "#F5F5F7",
  content: "#FFFFFF",
  glass: "rgba(246, 246, 248, 0.78)",
  "glass-line": "rgba(0, 0, 0, 0.08)",
  group: "#FFFFFF",
  separator: "rgba(60, 60, 67, 0.12)",
  "selection-strong": "rgba(0, 113, 227, 0.12)",
  tint: "#0071E3",
  "tint-ink": "#0066CC",
  ok: "#34C759",
  warn: "#FF9F0A",
  alert: "#FF3B30",
  "sig-goals": "#34C759",
  "sig-feed": "#FF2D55",
  "sig-ideas": "#FF9F0A",
  "sig-library": "#5856D6",
  "sig-waiting": "#FF9500",
  "sig-forks": "#AF52DE",
  ground: "#F5F5F7",
  "ground-wash": "#F5F5F7",
  panel: "rgba(246, 246, 248, 0.78)",
  solid: "#FFFFFF",
  line: "rgba(60, 60, 67, 0.12)",
  ink: "#1D1D1F",
  "ink-2": "#6E6E73",
  "ink-3": "#8E8E93",
  bubble: "#F2F2F7",
  selection: "rgba(0, 0, 0, 0.06)",
  "fork-1": "#2F7BF5",
  "fork-2": "#8A5CF6",
  "fork-3": "#E0782F",
  "fork-4": "#1F9E8A",
  "fork-5": "#D9467A",
  "fork-6": "#B8860B",
  ...tiles,
} as const;

const novaDark = {
  window: "#000000",
  content: "#161617",
  glass: "rgba(36, 36, 38, 0.72)",
  "glass-line": "rgba(255, 255, 255, 0.08)",
  group: "#232325",
  separator: "rgba(84, 84, 88, 0.45)",
  "selection-strong": "rgba(41, 151, 255, 0.18)",
  tint: "#0A84FF",
  "tint-ink": "#64B4FF",
  ok: "#30D158",
  warn: "#FF9F0A",
  alert: "#FF453A",
  "sig-goals": "#30D158",
  "sig-feed": "#FF375F",
  "sig-ideas": "#FF9F0A",
  "sig-library": "#5E5CE6",
  "sig-waiting": "#FF9F0A",
  "sig-forks": "#BF5AF2",
  ground: "#000000",
  "ground-wash": "#000000",
  panel: "rgba(36, 36, 38, 0.72)",
  solid: "#232325",
  line: "rgba(84, 84, 88, 0.45)",
  ink: "#F5F5F7",
  "ink-2": "#A1A1A6",
  "ink-3": "#8E8E93",
  bubble: "#2C2C2E",
  selection: "rgba(255, 255, 255, 0.08)",
  "fork-1": "#4B8DFF",
  "fork-2": "#A786FF",
  "fork-3": "#F29A57",
  "fork-4": "#3CC4AE",
  "fork-5": "#F06C9B",
  "fork-6": "#E0B43C",
  ...tiles,
} as const;

/**
 * Muse edition palettes. Light-first and quiet: ink primary, glass panels, hairline
 * borders. Applied only under `[data-product="muse"]`, so upstream Aiden keeps its own
 * palettes.
 */
export const museLightTokens = {
  background: novaLight.solid,
  foreground: novaLight.ink,
  card: novaLight.solid,
  cardForeground: novaLight.ink,
  popover: novaLight.solid,
  popoverForeground: novaLight.ink,
  primary: novaLight.ink,
  primaryForeground: novaLight.solid,
  secondary: novaLight.selection,
  secondaryForeground: novaLight.ink,
  chatUser: novaLight.bubble,
  chatUserForeground: novaLight.ink,
  muted: novaLight.bubble,
  mutedForeground: novaLight["ink-2"],
  accent: novaLight.selection,
  accentForeground: novaLight.ink,
  destructive: "#FF3B30",
  destructiveForeground: "#FFFFFF",
  border: novaLight.line,
  input: novaLight.line,
  // Keyboard focus: the accent at 50%.
  ring: "rgba(0, 113, 227, 0.5)",
  sidebar: novaLight.glass,
  sidebarForeground: novaLight.ink,
  sidebarBorder: novaLight.line,
  sidebarAccent: novaLight.selection,
  sidebarAccentForeground: novaLight.ink,
  link: "#0066CC",
  success: "#248A3D",
  warning: "#C93400",
  overlay: "rgba(17, 18, 22, 0.32)",
  scrollbar: "#D6D8DC",
  scrollbarHover: "#B6B9BF",
  ...novaLight,
} as const satisfies ColorTokens;

export const museDarkTokens = {
  background: novaDark.solid,
  foreground: novaDark.ink,
  card: novaDark.solid,
  cardForeground: novaDark.ink,
  popover: novaDark.solid,
  popoverForeground: novaDark.ink,
  primary: novaDark.ink,
  primaryForeground: novaDark.solid,
  secondary: novaDark.selection,
  secondaryForeground: novaDark.ink,
  chatUser: novaDark.bubble,
  chatUserForeground: novaDark.ink,
  muted: novaDark.bubble,
  mutedForeground: novaDark["ink-2"],
  accent: novaDark.selection,
  accentForeground: novaDark.ink,
  destructive: "#FF453A",
  destructiveForeground: "#FFFFFF",
  border: novaDark.line,
  input: novaDark.line,
  ring: "rgba(10, 132, 255, 0.55)",
  sidebar: novaDark.glass,
  sidebarForeground: novaDark.ink,
  sidebarBorder: novaDark.line,
  sidebarAccent: novaDark.selection,
  sidebarAccentForeground: novaDark.ink,
  link: "#2997FF",
  success: "#30D158",
  warning: "#FF9F0A",
  overlay: "rgba(0, 0, 0, 0.6)",
  scrollbar: "#2F3036",
  scrollbarHover: "#43454C",
  ...novaDark,
} as const satisfies ColorTokens;

/** Dark palette. Prefer `tokensForAppearance` when theme-aware. */
export const tokens = darkTokens;

export const RADIUS = "0.75rem";

export const botColors = [
  "#3EC5A8",
  "#F5A03C",
  "#6A6BF5",
  "#9B5CF6",
  "#3B82F6",
  "#F2622A",
  "#D9508A",
] as const;

export function isAppearancePreference(
  value: string | null | undefined,
): value is AppearancePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function normalizeAppearancePreference(
  raw: string | null | undefined,
): AppearancePreference {
  return isAppearancePreference(raw) ? raw : "system";
}

export type ResolveAppearancePreferenceOptions = {
  stored?: string | null;
  storage?: Pick<Storage, "getItem"> | null;
};

function getLocalStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function resolveAppearancePreference(
  options: ResolveAppearancePreferenceOptions = {},
): AppearancePreference {
  const stored =
    options.stored !== undefined
      ? options.stored
      : readStoredAppearance(options.storage ?? getLocalStorage());
  return normalizeAppearancePreference(stored);
}

export function persistAppearancePreference(
  preference: AppearancePreference,
  storage: Pick<Storage, "setItem"> | null = getLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(UI_APPEARANCE_STORAGE_KEY, preference);
  } catch {
    // Ignore quota / private-mode failures; in-memory preference still applies.
  }
}

export function resolveAppearance(
  preference: AppearancePreference,
  system: ResolvedAppearance = "dark",
): ResolvedAppearance {
  if (preference === "system") return system;
  return preference;
}

export function tokensForAppearance(appearance: ResolvedAppearance): ColorTokens {
  return appearance === "light" ? lightTokens : darkTokens;
}

function readStoredAppearance(storage: Pick<Storage, "getItem"> | null | undefined): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(UI_APPEARANCE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** `cardForeground` -> `--card-foreground` */
export function cssVariableName(token: keyof ColorTokens): string {
  return `--${token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

function renderBlock(selector: string, colorScheme: ResolvedAppearance, palette: ColorTokens) {
  const lines = (Object.keys(palette) as (keyof ColorTokens)[])
    .filter((token) => palette[token] !== undefined)
    .map((token) => `  ${cssVariableName(token)}: ${(palette[token] as string).toLowerCase()};`);
  return `${selector} {\n  color-scheme: ${colorScheme};\n${lines.join("\n")}\n  --radius: ${RADIUS};\n}`;
}

/** The CSS in `tokens.css`. Generated from the TS palette so both stay in sync. */
export function renderTokensCss(): string {
  return `${[
    "/* Generated by `pnpm --filter @aiden/ui-tokens generate`. Edit src/index.ts instead. */",
    "/* Muse: tint, tile-*, sig-*, alert, media-* and fork-* are owner-approved exceptions to the monochrome rule (Apple Mac-app design). */",
    renderBlock(':root,\n[data-theme="dark"]', "dark", darkTokens),
    renderBlock('[data-theme="light"]', "light", lightTokens),
    renderBlock('[data-product="muse"]', "light", museLightTokens),
    renderBlock('[data-product="muse"][data-theme="dark"]', "dark", museDarkTokens),
  ].join("\n\n")}\n`;
}
