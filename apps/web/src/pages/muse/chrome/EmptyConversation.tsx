import { useLingui } from "@lingui/react/macro";
import { BotAvatar } from "@rakazo/ui-web";
import { useMemo } from "react";
import { Chip } from "../ui";
import { greetingLead } from "./greeting";

/**
 * The empty Conversation (docs/muse/DESIGN.md "Conversation"): a centered Muse
 * face, a time-of-day serif greeting, one muted line, and a few suggestions
 * that send straight into the Conversation.
 */
export function EmptyConversation({
  botId,
  personName,
  avatarColor,
  onSend,
}: {
  botId: string;
  personName: string;
  avatarColor: string;
  onSend: (text: string) => void;
}) {
  const { t } = useLingui();
  // Stable for the life of this empty state; a running clock here would be
  // motion the person never asked for.
  const lead = useMemo(() => greetingLead(new Date(), personName), [personName]);
  const suggestions = [t`Plan my week`, t`Start a new goal`, t`What can you do?`];

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
      <BotAvatar color={avatarColor} identity={botId} face="muse" size={64} />
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
