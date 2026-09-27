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
