import { DEFAULT_MUSE_COLOR } from "@aiden/contracts";
import { BotAvatar } from "@aiden/ui-web";
import { useLingui } from "@lingui/react/macro";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Chip } from "../ui";
import {
  MiniAskRowIllustration,
  MiniGoalRingIllustration,
  MiniResultIllustration,
} from "./FirstRunIllustrations";

/** How long the Muse waves before settling into its idle face. */
const WAVE_DURATION_MS = 1400;

type FirstRunCardData = {
  key: string;
  title: string;
  body: string;
  example: string;
  illustration: ReactNode;
};

/**
 * The first-run welcome (F1 spec: "how they can do it in the UX"): shown in place of the
 * plain empty-Conversation greeting until the person sends a first message or dismisses
 * it (`EmptyConversation.tsx`, `useFirstRun("welcome")`). Aiden teaches by example, in its
 * own voice, in the Conversation itself — not a coach-mark slideshow: one short greeting,
 * then three compact cards that reveal in a gentle stagger (`motion-reduce` turns the
 * stagger off, same convention as `MuseWelcome.tsx`'s `ExampleCard`).
 */
export function FirstRunWelcome({
  botName,
  personName,
  avatarColor,
  onTryIt,
  onDismiss,
}: {
  botName: string;
  personName: string;
  avatarColor: string;
  /** Fills the composer with the example and focuses it; never sends on its own, so the
   * person sees what's about to go out (`Shell.tsx`'s `composerSeed`). */
  onTryIt: (text: string) => void;
  onDismiss: () => void;
}) {
  const { t } = useLingui();
  const [waving, setWaving] = useState(true);
  const trimmedName = personName.trim();
  const greeting = trimmedName
    ? t`Hi ${trimmedName}, I'm ${botName}. Here's how we'll work together.`
    : t`Hi, I'm ${botName}. Here's how we'll work together.`;

  useEffect(() => {
    const timer = window.setTimeout(() => setWaving(false), WAVE_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, []);

  const cards: FirstRunCardData[] = [
    {
      key: "do",
      title: t`Ask me anything, I'll do the work`,
      body: t`I have my own computer, browser and files.`,
      example: t`Summarize this week's rate-change news into a one-pager`,
      illustration: <MiniResultIllustration />,
    },
    {
      key: "goal",
      title: t`Give me a Goal, I'll keep going`,
      body: t`Say something bigger and I'll propose a plan; you approve it; I work in the background, check in, and show progress in Goals.`,
      example: t`Help me prepare the Q3 client portfolio review`,
      illustration: <MiniGoalRingIllustration />,
    },
    {
      key: "ask",
      title: t`I'll ask when I need you`,
      body: t`Questions and approvals collect in Waiting on you; answer in one tap.`,
      example: t`Draft my client follow-up email and check with me before sending it`,
      illustration: <MiniAskRowIllustration />,
    },
  ];

  return (
    <div
      data-testid="first-run-welcome"
      className="relative flex w-full max-w-[600px] flex-col items-center px-6 text-center"
    >
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t`Dismiss the intro`}
        className="absolute end-0 top-0 grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <X size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>

      <BotAvatar
        color={avatarColor || DEFAULT_MUSE_COLOR}
        identity="aiden"
        face="muse"
        size={96}
        museState={waving ? "waiting" : "idle"}
      />

      <p className="mt-4 max-w-[420px] font-display text-[22px] leading-tight text-foreground text-balance">
        {greeting}
      </p>

      <div className="mt-7 grid w-full grid-cols-1 gap-3 sm:grid-cols-3">
        {cards.map((card, index) => (
          <div
            key={card.key}
            className="flex animate-in fade-in slide-in-from-bottom-2 flex-col items-center gap-3 rounded-2xl border border-border bg-card p-4 text-start shadow-float motion-reduce:animate-none"
            style={{ animationDelay: `${index * 140}ms`, animationFillMode: "backwards" }}
          >
            <div className="flex h-14 w-full items-center justify-center">{card.illustration}</div>
            <div className="w-full">
              <h3 className="text-[14.5px] font-semibold leading-snug text-foreground">
                {card.title}
              </h3>
              <p className="mt-1 text-[13px] leading-[1.5] text-muted-foreground">{card.body}</p>
              <p className="mt-2.5 text-[12.5px] leading-[1.4] text-muted-foreground">
                {t`Try: "${card.example}"`}
              </p>
            </div>
            <Chip className="self-start" onClick={() => onTryIt(card.example)}>
              {t`Try it`}
            </Chip>
          </div>
        ))}
      </div>
    </div>
  );
}
