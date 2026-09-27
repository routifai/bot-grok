import { BotAvatar } from "@aiden/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import { FirstRunWelcome, useFirstRun } from "../intro";
import { Chip } from "../ui";
import { greetingLead } from "./greeting";

/**
 * The empty Conversation (docs/muse/DESIGN.md "Conversation"): a centered Muse
 * face, a time-of-day serif greeting, one muted line, and a few suggestions
 * that send straight into the Conversation. The very first time a person sees
 * this (per `useFirstRun("welcome")`), it shows the first-run welcome instead
 * — Aiden introducing itself and how to work together (`FirstRunWelcome.tsx`)
 * — until they send a message or dismiss it.
 */
export function EmptyConversation({
  botId,
  botName,
  personName,
  avatarColor,
  onSend,
  onTryIt,
}: {
  botId: string;
  botName: string;
  personName: string;
  avatarColor: string;
  onSend: (text: string) => void;
  /** Fills the composer with a first-run card's example (fill-then-focus, never a send). */
  onTryIt: (text: string) => void;
}) {
  const { t } = useLingui();
  const { seen: welcomeSeen, markSeen: dismissWelcome } = useFirstRun("welcome");
  // Stable for the life of this empty state; a running clock here would be
  // motion the person never asked for.
  const lead = useMemo(() => greetingLead(new Date(), personName), [personName]);
  const suggestions = [t`Plan my week`, t`Start a new goal`, t`What can you do?`];

  if (!welcomeSeen) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6">
        <FirstRunWelcome
          botId={botId}
          botName={botName}
          personName={personName}
          avatarColor={avatarColor}
          onTryIt={onTryIt}
          onDismiss={dismissWelcome}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
      <BotAvatar color={avatarColor} identity={botId} face="muse" size={96} />
      <div className="max-w-[380px]">
        <p className="font-display text-[24px] leading-tight text-foreground">{lead}</p>
        <p className="mt-1.5 text-[14px] text-muted-foreground">
          {t`Ask me anything, or tell me what you're working toward.`}
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {suggestions.map((text) => (
          <Chip key={text} onClick={() => onSend(text)}>
            {text}
          </Chip>
        ))}
      </div>
    </div>
  );
}
