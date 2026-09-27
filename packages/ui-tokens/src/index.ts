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
  /** Muse only: a floating panel's translucent fill, over the background wash. */
  glass?: string;
  /** Muse only: a floating panel's hairline border, over the background wash. */
  "glass-border"?: string;
  /** Muse only: the wash's first blurred color blob (sky blue family). */
  "wash-1"?: string;
  /** Muse only: the wash's second blurred color blob (faint lilac). */
  "wash-2"?: string;
  /** Muse only: the wash's third blurred color blob (faint cyan). */
  "wash-3"?: string;
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
 * Muse edition palettes (docs/muse/DESIGN.md). Light-first and quiet: white surfaces,
 * hairline borders, ink primary. Applied only under `[data-product="muse"]`, so upstream
 * Aiden keeps its own palettes.
 */
export const museLightTokens = {
  background: "#FFFFFF",
  foreground: "#15161A",
  card: "#FFFFFF",
  cardForeground: "#15161A",
  popover: "#FFFFFF",
  popoverForeground: "#15161A",
  primary: "#15161A",
  primaryForeground: "#FFFFFF",
  secondary: "#F4F4F5",
  secondaryForeground: "#15161A",
  chatUser: "#F2F3F5",
  chatUserForeground: "#15161A",
  muted: "#F7F7F8",
  mutedForeground: "#6A6E76",
  accent: "#F1F2F4",
  accentForeground: "#15161A",
  destructive: "#D6363C",
  destructiveForeground: "#FFFFFF",
  border: "#E8E9EC",
  input: "#E3E4E8",
  ring: "#9A9EA6",
  sidebar: "#F3F3F5",
  sidebarForeground: "#15161A",
  sidebarBorder: "#E6E7EA",
  sidebarAccent: "#E7E8EC",
  sidebarAccentForeground: "#15161A",
  link: "#1F6FEB",
  success: "#1E8A4E",
  warning: "#B26A00",
  overlay: "rgba(17, 18, 22, 0.32)",
  scrollbar: "#D6D8DC",
  scrollbarHover: "#B6B9BF",
  // Glass shell (docs/muse/DESIGN.md "Background wash"): floating panels over a soft,
  // blurred wash of Aiden's sky blue plus a faint lilac and cyan.
  glass: "rgba(255, 255, 255, 0.74)",
  "glass-border": "rgba(255, 255, 255, 0.6)",
  "wash-1": "rgba(59, 130, 246, 0.16)",
  "wash-2": "rgba(168, 139, 250, 0.12)",
  "wash-3": "rgba(94, 211, 217, 0.1)",
} as const satisfies ColorTokens;

export const museDarkTokens = {
  background: "#17181B",
  foreground: "#ECEDEF",
  card: "#1E1F23",
  cardForeground: "#ECEDEF",
  popover: "#212226",
  popoverForeground: "#ECEDEF",
  primary: "#F2F2F3",
  primaryForeground: "#17181B",
  secondary: "#25262B",
  secondaryForeground: "#ECEDEF",
  chatUser: "#2A2B30",
  chatUserForeground: "#ECEDEF",
  muted: "#1E1F23",
  mutedForeground: "#999CA3",
  accent: "#26272C",
  accentForeground: "#ECEDEF",
  destructive: "#F0565C",
  destructiveForeground: "#FFFFFF",
  border: "#2C2D32",
  input: "#303137",
  ring: "#6B6F77",
  sidebar: "#121316",
  sidebarForeground: "#ECEDEF",
  sidebarBorder: "#222328",
  sidebarAccent: "#24252A",
  sidebarAccentForeground: "#ECEDEF",
  link: "#6EA8FE",
  success: "#4CC382",
  warning: "#E3A63B",
  overlay: "rgba(0, 0, 0, 0.6)",
  scrollbar: "#2F3036",
  scrollbarHover: "#43454C",
  // Deeper and lower-opacity than the light wash, so the blobs stay a quiet tint.
  glass: "rgba(30, 31, 35, 0.74)",
  "glass-border": "rgba(255, 255, 255, 0.07)",
  "wash-1": "rgba(59, 130, 246, 0.1)",
  "wash-2": "rgba(139, 92, 246, 0.09)",
  "wash-3": "rgba(45, 175, 185, 0.08)",
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
