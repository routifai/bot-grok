import type { ActivitySource } from "@nova/contracts";
import type { ToolIconKey } from "@nova/core";
import type { LucideIcon } from "lucide-react";
import {
  Bot,
  CalendarClock,
  Circle,
  Fingerprint,
  Globe,
  History,
  MessageCircle,
  MessagesSquare,
  NotebookPen,
  Search,
  Target,
} from "lucide-react";

// A Step's icon (docs/super-chat/README.md "The Activity panel"; the owner's "always show
// icons, never the tool name"): one lucide icon per `ToolIconKey`
// (packages/core/src/tool-presentation.ts), reusing `Fingerprint` from the Memory tab
// (ContextPanel.tsx) so "memory" reads the same way in both places.
export const TOOL_ICON_COMPONENT: Record<ToolIconKey, LucideIcon> = {
  search: Search,
  web: Globe,
  memory: Fingerprint,
  helper: Bot,
  sideChat: MessagesSquare,
  history: History,
  generic: Circle,
};

/** An Activity's icon by where it came from (packages/contracts/src/activity.ts
 * `ActivitySource`): a Conversation turn, a Side Chat turn, background work, a scheduled
 * Helper (standing task, followed topic) or a Goal's cadence. */
export const ACTIVITY_SOURCE_ICON: Record<ActivitySource, LucideIcon> = {
  turn: MessageCircle,
  side_chat: MessagesSquare,
  background: Bot,
  housekeeping: NotebookPen,
  scheduled: CalendarClock,
  goal: Target,
};
