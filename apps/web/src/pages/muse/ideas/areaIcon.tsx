import type { Idea, IllustrationKey } from "@aiden/contracts";

/** Sentence-case group heading from an Idea's raw area label ("learning" → "Learning"). */
export function areaLabel(area: string): string {
  const trimmed = area.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * Area → bundled 3D illustration (owner-approved exception to AGENTS.md's monochrome
 * note, for these illustrations only), for when the model didn't pick one itself.
 */
const AREA_ILLUSTRATION: Record<string, IllustrationKey> = {
  learning: "books",
  education: "books",
  career: "briefcase",
  work: "briefcase",
  productivity: "clipboard",
  clients: "handshake",
  client: "handshake",
  finance: "money-bag",
  money: "money-bag",
  investing: "bar-chart",
  travel: "globe",
  writing: "spiral-notepad",
  research: "magnifying-glass",
  compliance: "shield",
  risk: "shield",
  social: "speech-balloon",
};

/**
 * The illustration for an Idea's row: the model's own pick, else its area's default,
 * else a sensible fallback. Every Idea gets a 3D illustration — never a line icon.
 */
export function ideaIllustration(idea: Pick<Idea, "area" | "illustration">): IllustrationKey {
  return idea.illustration ?? AREA_ILLUSTRATION[idea.area.trim().toLowerCase()] ?? "light-bulb";
}
