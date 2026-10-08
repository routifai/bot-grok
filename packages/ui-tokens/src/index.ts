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
 * Nova's surfaces (docs/muse/DESIGN.md): quiet glass panels on a cool ground, ink text in
 * three strengths, hairline lines. The Muse palettes below map the shadcn slots onto these
 * same values, so each color is written once. `background` is the solid surface (shadcn
 * controls paint it inside panels); only the shell root paints `ground`.
 *
 * `fork-*` are an owner-approved exception to the monochrome rule (where only bots carry
 * an identity color): each side chat (fork) gets one, so a fork reads as the same thread
 * in the rail, the transcript and its own view.
 */
const novaLight = {
  ground: "#EEF1F7",
  "ground-wash": "#E4EAF6",
  panel: "rgba(255, 255, 255, 0.8)",
  solid: "#FFFFFF",
  line: "#E3E6EE",
  ink: "#15171C",
  "ink-2": "#5B6170",
  "ink-3": "#9AA0AE",
  bubble: "#EEF0F4",
  selection: "#E9EDF5",
  "fork-1": "#2F7BF5",
  "fork-2": "#8A5CF6",
  "fork-3": "#E0782F",
  "fork-4": "#1F9E8A",
  "fork-5": "#D9467A",
  "fork-6": "#B8860B",
} as const;

const novaDark = {
  // Deeper ground with a visible blue glow, so the lifted panels read as separate surfaces.
  ground: "#0A0B0F",
  "ground-wash": "#172038",
  panel: "rgba(26, 29, 38, 0.84)",
  solid: "#1C1F28",
  line: "#2B303C",
  ink: "#ECEEF3",
  "ink-2": "#A7ADBA",
  "ink-3": "#6E7485",
  bubble: "#272B36",
  selection: "#272D3B",
  "fork-1": "#4B8DFF",
  "fork-2": "#A786FF",
  "fork-3": "#F29A57",
  "fork-4": "#3CC4AE",
  "fork-5": "#F06C9B",
  "fork-6": "#E0B43C",
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
  destructive: "#D6363C",
  destructiveForeground: "#FFFFFF",
  border: novaLight.line,
  input: novaLight.line,
  ring: novaLight["ink-3"],
  sidebar: novaLight.ground,
  sidebarForeground: novaLight.ink,
  sidebarBorder: novaLight.line,
  sidebarAccent: novaLight.selection,
  sidebarAccentForeground: novaLight.ink,
  link: "#1F6FEB",
  success: "#1E8A4E",
  warning: "#B26A00",
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
  destructive: "#F0565C",
  destructiveForeground: "#FFFFFF",
  border: novaDark.line,
  input: novaDark.line,
  ring: novaDark["ink-3"],
  sidebar: novaDark.ground,
  sidebarForeground: novaDark.ink,
  sidebarBorder: novaDark.line,
  sidebarAccent: novaDark.selection,
  sidebarAccentForeground: novaDark.ink,
  link: "#6EA8FE",
  success: "#4CC382",
  warning: "#E3A63B",
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
    renderBlock(':root,\n[data-theme="dark"]', "dark", darkTokens),
    renderBlock('[data-theme="light"]', "light", lightTokens),
    renderBlock('[data-product="muse"]', "light", museLightTokens),
    renderBlock('[data-product="muse"][data-theme="dark"]', "dark", museDarkTokens),
  ].join("\n\n")}\n`;
}
