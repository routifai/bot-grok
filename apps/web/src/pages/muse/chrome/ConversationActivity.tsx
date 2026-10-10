import { useLingui } from "@lingui/react/macro";
import { ChevronDown, Clock } from "lucide-react";
import { useState } from "react";
import { HomeActivity } from "./HomeActivity";

/**
 * The Activity card in the Conversation: a small glass pill bottom-right that opens the same
 * card the home shows, so it never sits over the transcript unless asked for.
 */
export function ConversationActivity({ botId }: { botId: string }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        data-testid="activity-pill"
        onClick={() => setOpen(true)}
        className="sc-glass inline-flex h-11 items-center gap-2 rounded-xl px-3.5 text-[14px] font-medium text-foreground transition-colors hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Clock size={18} strokeWidth={1.7} aria-hidden="true" />
        {t`Activity`}
      </button>
    );
  }
  return (
    <div className="relative">
      <HomeActivity botId={botId} className="shadow-float" />
      <button
        type="button"
        aria-label={t`Hide activity`}
        title={t`Hide activity`}
        onClick={() => setOpen(false)}
        className="absolute -top-3 end-3 z-20 grid size-8 place-items-center rounded-full border border-glass-line bg-window text-foreground transition-colors hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ChevronDown size={16} strokeWidth={2} />
      </button>
    </div>
  );
}
