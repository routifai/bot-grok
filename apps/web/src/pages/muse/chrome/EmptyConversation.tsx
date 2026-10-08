import { useLingui } from "@lingui/react/macro";
import { CalendarDays, Sparkles, Target } from "lucide-react";
import { useMemo } from "react";
import type { Suggestion } from "../ui";
import { MUSE_TYPE, SuggestionChips } from "../ui";
import { greetingLead } from "./greeting";

/**
 * The empty Conversation's start page, above the composer: a time-of-day greeting and one
 * muted line, sitting on the composer (Shell.tsx centers the composer between this and
 * `EmptyConversationSuggestions`). No face; the greeting is the whole welcome.
 */
export function EmptyConversationLead({ personName }: { personName: string }) {
  const { t } = useLingui();
  // Stable for the life of this empty state; a running clock here would be
  // motion the person never asked for.
  const lead = useMemo(() => greetingLead(new Date(), personName), [personName]);
  return (
    <div
      data-testid="empty-conversation"
      className="flex flex-1 flex-col justify-end px-5 pt-10 pb-6 sm:px-8"
    >
      <div className="mx-auto w-full max-w-[640px] text-center motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-500">
        <h1 className={MUSE_TYPE.heroTitle}>{lead}</h1>
        <p className="mt-2 text-[15px] leading-[1.5] text-pretty text-ink-2">
          {t`Ask me anything, or tell me what you're working toward.`}
        </p>
      </div>
    </div>
  );
}

/** The start page's suggestions, under the composer: a few quiet chips that send at once. */
export function EmptyConversationSuggestions({ onSend }: { onSend: (text: string) => void }) {
  const { t } = useLingui();
  const suggestions: Suggestion[] = [
    { text: t`Plan my week`, icon: CalendarDays },
    { text: t`Start a new goal`, icon: Target },
    { text: t`What can you do?`, icon: Sparkles },
  ];
  return (
    <div className="flex flex-1 flex-col px-5 pt-1 pb-10 sm:px-8">
      <SuggestionChips
        suggestions={suggestions}
        onSuggestion={onSend}
        className="mx-auto max-w-[640px] motion-safe:animate-in motion-safe:fade-in motion-safe:duration-700"
      />
    </div>
  );
}
