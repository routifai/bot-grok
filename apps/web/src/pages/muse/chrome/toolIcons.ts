import type { ToolIconKey } from "@aiden/core";
import type { LucideIcon } from "lucide-react";
import { Bot, Circle, Fingerprint, History, MessagesSquare, Search } from "lucide-react";

// A Step's icon (docs/super-chat/README.md "The Activity panel"; the owner's "always show
// icons, never the tool name"): one lucide icon per `ToolIconKey`
// (packages/core/src/tool-presentation.ts), reusing `Fingerprint` from the Memory tab
// (ContextPanel.tsx) so "memory" reads the same way in both places.
export const TOOL_ICON_COMPONENT: Record<ToolIconKey, LucideIcon> = {
  search: Search,
  memory: Fingerprint,
  helper: Bot,
  sideChat: MessagesSquare,
  history: History,
  generic: Circle,
};
