import type { ComposerMention } from "@nova/core";
import { BotAvatar } from "@nova/ui-web";
import { Clock, Puzzle } from "lucide-react";
import { FALLBACK_BOT_COLOR } from "./shared";

export function MentionOptionIcon({ mention }: { mention: ComposerMention }) {
  if (mention.kind === "routine") {
    return <Clock size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-muted-foreground" />;
  }
  if (mention.kind === "connector") {
    return <Puzzle size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-muted-foreground" />;
  }
  if (mention.kind === "group") {
    return (
      <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-accent text-[9px] text-foreground/75">
        G
      </span>
    );
  }
  if (mention.kind === "everyone") {
    return (
      <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-accent text-[9px] text-foreground/75">
        @
      </span>
    );
  }
  return <BotAvatar color={mention.color ?? FALLBACK_BOT_COLOR} identity={mention.id} size={16} />;
}

export function MentionChipIcon({ mention }: { mention: ComposerMention }) {
  if (mention.kind === "routine") {
    return <Clock size={13} strokeWidth={1.7} className="shrink-0 text-muted-foreground/70" />;
  }
  if (mention.kind === "connector") {
    return <Puzzle size={13} strokeWidth={1.7} className="shrink-0 text-muted-foreground/70" />;
  }
  if (mention.kind === "group" || mention.kind === "everyone") {
    return (
      <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-accent text-[9px] text-foreground/75">
        {mention.kind === "group" ? "G" : "@"}
      </span>
    );
  }
  return <BotAvatar color={mention.color ?? FALLBACK_BOT_COLOR} identity={mention.id} size={16} />;
}
