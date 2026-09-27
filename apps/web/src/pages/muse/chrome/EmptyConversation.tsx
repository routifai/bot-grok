import { useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import { EmptyState } from "../ui";
import { greetingLead } from "./greeting";

/**
 * The empty Conversation (docs/muse/DESIGN.md "Conversation"): the shared `EmptyState`
 * — the Muse's face, a time-of-day sans greeting, one muted line, and a few
 * suggestions that send straight into the Conversation.
 */
export function EmptyConversation({
  personName,
  avatarColor,
  onSend,
}: {
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
    <EmptyState
      avatarColor={avatarColor}
      headline={lead}
      suggestions={suggestions}
      onSuggestion={onSend}
    >
      {t`Ask me anything, or tell me what you're working toward.`}
    </EmptyState>
  );
}
