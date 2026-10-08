import type { ThreadMessage } from "@aiden/contracts";
import { BotAvatar, cn } from "@aiden/ui-web";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { MuseLiveStatus } from "./MuseLiveStatus";
import { type ChatProject, ProjectChip } from "./ProjectChip";
import type { MuseLiveRun } from "./useMuseLiveState";

/**
 * The Conversation's header (docs/muse/DESIGN.md "Conversation" / "Status"): a 56px strip
 * above the transcript with a hairline underneath.
 * A compact identity (face + name) sits at the start whenever the context panel's own
 * Agent Identity header isn't visible (`identityCollapsed`: collapsed, a side panel
 * open, or below `xl` — ContextPanel.tsx), so the Muse's identity still shows exactly
 * once, whichever of the two layouts is active. The live Muse indicator sits in the
 * center (nothing while idle) beside a quiet "Working in" chip when a Project is open, and
 * quiet round controls (the context panel, the
 * computer) sit on the right.
 */
export function ConversationHeader({
  botId,
  museName,
  color,
  runs,
  messages,
  actions,
  identityCollapsed,
  onOpenWaiting,
  project,
  onOpenProject,
}: {
  botId: string;
  museName: string;
  color: string;
  runs: readonly MuseLiveRun[];
  messages: readonly ThreadMessage[] | undefined;
  actions?: ReactNode;
  /** Whether the context panel's own identity header isn't visible right now, so this
   * header's compact identity should show instead. */
  identityCollapsed: boolean;
  onOpenWaiting?: () => void;
  project?: ChatProject | null;
  onOpenProject?: (project: ChatProject) => void;
}) {
  const { t } = useLingui();
  return (
    <div className="app-drag pointer-events-none relative z-10 flex h-14 shrink-0 items-center justify-center border-b border-line px-4 md:px-6">
      <div
        data-testid="conversation-header-compact-identity"
        className={cn(
          "app-no-drag pointer-events-auto absolute inset-y-0 start-4 flex min-w-0 items-center gap-2 md:start-6",
          // Forced-collapsed (`identityCollapsed`): the context panel never shows, at any
          // width, so this stays visible unconditionally. Otherwise it only fills in
          // below `xl`, where the context panel's own header disappears on its own.
          !identityCollapsed && "xl:hidden",
        )}
      >
        <BotAvatar color={color} identity={botId} face="muse" size={28} />
        <span className="truncate text-[15px] font-semibold text-foreground" dir="auto">
          {museName}
        </span>
      </div>
      {identityCollapsed ? null : (
        // Wherever the compact identity hides (the context panel shows the Muse instead),
        // the strip names the view, as the rail does.
        <h1
          data-testid="conversation-header-title"
          className="pointer-events-none absolute inset-y-0 start-4 hidden items-center text-[15px] font-semibold text-foreground md:start-6 xl:flex"
        >
          {t`Conversation`}
        </h1>
      )}
      <div className="app-no-drag pointer-events-auto flex items-center gap-2">
        {project && onOpenProject ? <ProjectChip project={project} onOpen={onOpenProject} /> : null}
        <MuseLiveStatus
          botId={botId}
          color={color}
          runs={runs}
          messages={messages}
          onOpenWaiting={onOpenWaiting}
        />
      </div>
      {actions ? (
        <div className="app-no-drag pointer-events-auto absolute inset-y-0 end-4 flex items-center gap-1.5 md:end-6">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
