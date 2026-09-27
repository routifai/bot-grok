import type { Idea, IllustrationKey } from "@aiden/contracts";
import {
  BookOpen,
  Briefcase,
  Globe,
  Handshake,
  HeartPulse,
  KanbanSquare,
  type LucideIcon,
  PenLine,
  PiggyBank,
  Plane,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { illustrationUrl } from "../../../lib/illustrations";

/**
 * A quiet, monochrome icon for an Idea's area (no emoji, no color — AGENTS.md: the app
 * stays monochrome, identity color belongs only to the bot). Purely a client-side
 * presentation touch; falls back to a generic spark when the area doesn't match.
 */
const AREA_ICON: Record<string, LucideIcon> = {
  learning: BookOpen,
  education: BookOpen,
  career: Briefcase,
  work: Briefcase,
  productivity: KanbanSquare,
  clients: Handshake,
  client: Handshake,
  finance: PiggyBank,
  money: PiggyBank,
  investing: PiggyBank,
  health: HeartPulse,
  wellness: HeartPulse,
  fitness: HeartPulse,
  travel: Plane,
  writing: PenLine,
  research: Search,
  compliance: ShieldCheck,
  risk: ShieldCheck,
  social: Globe,
};

export function ideaIcon(area: string): LucideIcon {
  return AREA_ICON[area.trim().toLowerCase()] ?? Sparkles;
}

/** Sentence-case group heading from an Idea's raw area label ("learning" → "Learning"). */
export function areaLabel(area: string): string {
  const trimmed = area.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * Bundled 3D illustration (owner-approved exception to AGENTS.md's monochrome note,
 * for these illustrations only) for an Idea's area, when the area matches a fitting one.
 * Areas with no good fit (health, wellness, fitness, ...) fall through to `ideaIcon`.
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

/** The illustration to show for an Idea: its own key, or its area's default. */
function ideaIllustration(idea: Pick<Idea, "area" | "illustration">): IllustrationKey | undefined {
  return idea.illustration ?? AREA_ILLUSTRATION[idea.area.trim().toLowerCase()];
}

/**
 * An Idea row's leading icon: a bare 36px 3D illustration (no tinted tile — the
 * illustration carries its own depth) when one fits, otherwise the quiet monochrome
 * lucide icon in its muted tile.
 */
export function IdeaIcon({ idea }: { idea: Idea }) {
  const key = ideaIllustration(idea);
  if (key) {
    return <img src={illustrationUrl(key)} alt="" loading="lazy" className="size-9 shrink-0" />;
  }
  const Icon = ideaIcon(idea.area);
  return (
    <span
      aria-hidden="true"
      className="grid size-10 shrink-0 place-items-center rounded-2xl bg-muted"
    >
      <Icon size={19} strokeWidth={1.75} className="text-muted-foreground" />
    </span>
  );
}
