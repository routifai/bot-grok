import type { Idea, IllustrationKey } from "@aiden/contracts";
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Bell,
  BookOpen,
  Briefcase,
  Calendar,
  CircleDollarSign,
  CreditCard,
  FileText,
  Globe,
  GraduationCap,
  Handshake,
  House,
  Landmark,
  Laptop,
  Lightbulb,
  Mail,
  MessageCircle,
  Newspaper,
  NotebookPen,
  Rocket,
  Search,
  ShieldCheck,
  TrendingUp,
  Trophy,
  Wallet,
} from "lucide-react";

/** Sentence-case group heading from an Idea's raw area label ("learning" → "Learning"). */
export function areaLabel(area: string): string {
  const trimmed = area.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** Area → icon key, for when the model didn't pick one itself. */
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

/** The model's icon keys, drawn as monochrome line icons (the app is monochrome). */
const KEY_ICON: Record<IllustrationKey, LucideIcon> = {
  bank: Landmark,
  briefcase: Briefcase,
  "chart-increasing": TrendingUp,
  "bar-chart": BarChart3,
  "money-bag": Wallet,
  coin: CircleDollarSign,
  "credit-card": CreditCard,
  "dollar-banknote": CircleDollarSign,
  "light-bulb": Lightbulb,
  "spiral-calendar": Calendar,
  "spiral-notepad": NotebookPen,
  clipboard: FileText,
  books: BookOpen,
  "graduation-cap": GraduationCap,
  "magnifying-glass": Search,
  envelope: Mail,
  handshake: Handshake,
  laptop: Laptop,
  globe: Globe,
  newspaper: Newspaper,
  bell: Bell,
  trophy: Trophy,
  rocket: Rocket,
  shield: ShieldCheck,
  "speech-balloon": MessageCircle,
  house: House,
};

/** The line icon for an Idea's row: the model's own pick, else its area's, else a bulb. */
export function ideaIcon(idea: Pick<Idea, "area" | "illustration">): LucideIcon {
  const key =
    idea.illustration ?? AREA_ILLUSTRATION[idea.area.trim().toLowerCase()] ?? "light-bulb";
  return KEY_ICON[key];
}
