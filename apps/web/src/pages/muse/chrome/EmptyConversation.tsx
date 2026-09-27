import { useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import { FirstRunWelcome, useFirstRun } from "../intro";
import { EmptyState } from "../ui";
import { greetingLead } from "./greeting";

/**
 * The empty Conversation (docs/muse/DESIGN.md "Conversation"): the shared `EmptyState`
 * — the Muse's face, a time-of-day sans greeting, one muted line, and a few
 * suggestions that send straight into the Conversation. The very first time a person
 * sees this (per `useFirstRun("welcome")`), it shows the first-run welcome instead —
 * Aiden introducing itself and how to work together (`FirstRunWelcome.tsx`) — until
 * they send a message or dismiss it.
 */
export function EmptyConversation({
  botName,
  personName,
  avatarColor,
  onSend,
  onTryIt,
}: {
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
