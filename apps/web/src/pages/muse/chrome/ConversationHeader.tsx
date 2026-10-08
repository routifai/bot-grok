import type { ThreadMessage } from "@aiden/contracts";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { NovaOrb } from "../../../components/ai/orb";
import { MuseLiveStatus } from "./MuseLiveStatus";
import { type ChatProject, ProjectChip } from "./ProjectChip";
import type { MuseLiveRun } from "./useMuseLiveState";

/** A button inside the toolbar's glass pill group. */
export const TOOLBAR_BUTTON =
  "grid h-7 min-w-[30px] place-items-center rounded-full px-2.5 text-ink-2 transition-colors hover:bg-selection hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring data-active:bg-selection data-active:text-foreground [&_svg]:size-[15px]";

/** The toolbar's glass pill that groups its buttons, Mac style. */
export function ToolbarGroup({ children }: { children: ReactNode }) {
  return (
    <div className="nova-glass-pill inline-flex h-8 items-center gap-px rounded-full p-0.5">
      {children}
    </div>
  );
}

/**
 * The Conversation's toolbar (docs/muse/DESIGN.md "Window"): 56px, no hairline. The title
 * with a quiet subtitle beside it (Nova's live status while it works, "New" on the start
 * page), and the header actions on the right in one glass pill group. Below `xl`, where the
 * inspector and its Nova header are hidden, a small orb leads the title so Nova still shows.
 */
export function ConversationHeader({
  botId,
  color,
  runs,
  messages,
  actions,
  leading,
  identityCollapsed,
  isNew = false,
  onOpenWaiting,
  project,
  onOpenProject,
}: {
  botId: string;
  /** Kept for callers; the orb replaced the colored face. */
  museName?: string;
  color: string;
  runs: readonly MuseLiveRun[];
  messages: readonly ThreadMessage[] | undefined;
  /** Buttons for the glass pill group. */
  actions?: ReactNode;
  /** Controls that sit before the pill group (the Chat | Forks switch). */
  leading?: ReactNode;
  /** Whether the inspector's own Nova header isn't visible right now. */
  identityCollapsed: boolean;
  /** The empty start page: the subtitle reads "New". */
  isNew?: boolean;
  onOpenWaiting?: () => void;
  project?: ChatProject | null;
  onOpenProject?: (project: ChatProject) => void;
}) {
  const { t } = useLingui();
  return (
    <div className="app-drag relative z-10 flex h-14 shrink-0 items-center gap-2.5 ps-5 pe-4">
      <span
        data-testid="conversation-header-compact-identity"
        className={identityCollapsed ? "flex" : "flex xl:hidden"}
      >
        <NovaOrb size={22} />
      </span>
      <h1
        data-testid="conversation-header-title"
        className="shrink-0 text-[15px] font-semibold tracking-[-0.2px] text-foreground"
      >
        {t`Conversation`}
      </h1>
      <div className="app-no-drag flex min-w-0 items-center gap-2 text-[12px] text-ink-3">
        <MuseLiveStatus
          botId={botId}
          color={color}
          runs={runs}
          messages={messages}
          onOpenWaiting={onOpenWaiting}
          fallback={isNew ? t`New` : null}
        />
        {project && onOpenProject ? <ProjectChip project={project} onOpen={onOpenProject} /> : null}
      </div>
      <span className="flex-1" />
      {leading || actions ? (
        <div className="app-no-drag flex shrink-0 items-center gap-2">
          {leading}
          {actions ? <ToolbarGroup>{actions}</ToolbarGroup> : null}
        </div>
      ) : null}
    </div>
  );
}
