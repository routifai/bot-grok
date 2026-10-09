import { useLingui } from "@lingui/react/macro";
import type { ThreadMessage } from "@nova/contracts";
import { Menu } from "lucide-react";
import type { ReactNode } from "react";
import { NovaOrb, useOrbHome } from "../../../components/ai/orb";
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
 * page), and the header actions on the right in one glass pill group. While the sidebar is
 * collapsed or hidden, Nova's orb leads the title (its one fallback home, placement.tsx).
 */
export function ConversationHeader({
  botId,
  color,
  runs,
  messages,
  actions,
  leading,
  isNew = false,
  onOpenWaiting,
  onOpenMenu,
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
  /** Kept for callers; the orb's place comes from `useOrbHome`. */
  identityCollapsed?: boolean;
  /** The empty start page: the subtitle reads "New". */
  isNew?: boolean;
  onOpenWaiting?: () => void;
  /** Phone only: opens the sidebar drawer. The one header carries the menu, so no second bar. */
  onOpenMenu?: () => void;
  project?: ChatProject | null;
  onOpenProject?: (project: ChatProject) => void;
}) {
  const { t } = useLingui();
  // The orb's fallback home: here only while the sidebar is collapsed or hidden.
  const orbHere = useOrbHome("toolbar");
  return (
    <div className="app-drag relative z-10 flex h-14 min-w-0 shrink-0 items-center gap-2 ps-2 pe-3 md:gap-2.5 md:ps-5 md:pe-4">
      {onOpenMenu ? (
        <button
          type="button"
          data-testid="mobile-nav-trigger"
          title={t`Menu`}
          aria-label={t`Menu`}
          onClick={onOpenMenu}
          className="app-no-drag grid size-9 shrink-0 place-items-center rounded-full text-foreground/80 transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring md:hidden"
        >
          <Menu size={20} strokeWidth={1.75} />
        </button>
      ) : null}
      {orbHere ? (
        <span data-testid="conversation-header-compact-identity" className="flex">
          <NovaOrb size={22} />
        </span>
      ) : null}
      <h1
        data-testid="conversation-header-title"
        className="min-w-0 shrink truncate text-[15px] font-semibold tracking-[-0.2px] text-foreground"
      >
        {t`Conversation`}
      </h1>
      <div className="app-no-drag flex min-w-0 shrink-[2] items-center gap-2 overflow-hidden text-[12px] text-ink-3">
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
      <span className="min-w-0 flex-1" />
      {leading || actions ? (
        <div className="app-no-drag flex shrink-0 items-center gap-2">
          {leading}
          {actions ? <ToolbarGroup>{actions}</ToolbarGroup> : null}
        </div>
      ) : null}
    </div>
  );
}
