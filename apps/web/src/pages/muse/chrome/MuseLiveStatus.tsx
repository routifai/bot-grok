import type { ThreadMessage } from "@aiden/contracts";
import { BotAvatar } from "@aiden/ui-web";
import { useLingui } from "@lingui/react/macro";
import { Shimmer } from "../../../components/ai/primitives";
import { StatusPill } from "../ui";
import { deriveStatusPill } from "./statusPill";
import { type MuseLiveRun, useMuseLiveState } from "./useMuseLiveState";

/**
 * The live Muse indicator (docs/muse/DESIGN.md "Status"): nothing while idle, a small
 * animated face plus a shimmering verb while thinking/working ("Thinking…",
 * "Browsing…", "Running code…"), or a clickable "Needs you" pill while an Ask is
 * open. Self-sufficient beyond the live run/message data every muse-mode surface
 * already has, so it drops into the Conversation header, a future header redesign,
 * or anywhere else the Muse's live state should show.
 */
export function MuseLiveStatus({
  botId,
  color,
  runs,
  messages,
  onOpenWaiting,
}: {
  botId: string;
  color: string;
  runs: readonly MuseLiveRun[];
  messages: readonly ThreadMessage[] | undefined;
  onOpenWaiting?: () => void;
}) {
  const { t } = useLingui();
  const { state, label } = useMuseLiveState({ botId, runs, messages });
  if (!label) return null;

  const pill = deriveStatusPill(state);
  if (pill) {
    return (
      <StatusPill tone={pill.tone} onClick={onOpenWaiting} label={t`Open what's waiting on you`}>
        {pill.text}
      </StatusPill>
    );
  }

  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[13.5px] text-muted-foreground">
      <BotAvatar color={color} identity={botId} face="muse" museState={state} size={18} />
      <Shimmer>{label}</Shimmer>
    </span>
  );
}
