import { DEFAULT_MUSE_COLOR } from "@aiden/contracts";
import { BotAvatar, cn } from "@aiden/ui-web";
import { Trans } from "@lingui/react/macro";
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { WindowChrome } from "../../WindowChrome";
import { Eyebrow } from "../ui";
import { AuroraBackground } from "./AuroraBackground";

// The signed-out welcome in Muse mode (docs/muse/DESIGN.md): Aiden introduces itself as a
// proactive AI teammate, with three small examples of the everyday work it takes on.
export function MuseWelcome() {
  const navigate = useNavigate();
  return (
    <div className="relative isolate flex min-h-full flex-col" data-aiden-surface="welcome">
      <AuroraBackground />
      <div className="app-drag flex gap-2 px-5 py-[18px]">
        <WindowChrome />
      </div>
      <main className="flex flex-1 flex-col items-center justify-center px-6 py-10">
        <div className="flex w-full max-w-[720px] flex-col items-center text-center">
          <div className="relative mb-7">
            <BotAvatar color={DEFAULT_MUSE_COLOR} identity="aiden" face="muse" size={148} />
            <span className="absolute -top-3 start-[134px] whitespace-nowrap rounded-2xl rounded-bl-md border border-border bg-card px-3 py-1.5 text-[13px] text-foreground shadow-float">
              <Trans>Hi, I'm Nova.</Trans>
            </span>
          </div>

          <h1 className="font-display text-[44px] leading-[1.02] tracking-[-0.015em] text-foreground text-balance sm:text-[60px]">
            <Trans>
              Your AI, <em className="italic">already on it.</em>
            </Trans>
          </h1>
          <p className="mt-5 max-w-[520px] text-[17px] leading-[1.55] text-muted-foreground text-balance">
            <Trans>
              Nova prepares your meetings, researches, drafts and follows up in the background — and
              always asks before anything it can't undo.
            </Trans>
          </p>

          <div className="mt-9 grid w-full grid-cols-1 gap-3 sm:grid-cols-3">
            <ExampleCard eyebrow={<Trans>Prepares</Trans>} tilt="-rotate-1" delay="0s">
              <Trans>
                Your briefing for Thursday's credit committee is ready, risks on page 2.
              </Trans>
            </ExampleCard>
            <ExampleCard eyebrow={<Trans>Watches</Trans>} tilt="rotate-1" delay="0.6s">
              <Trans>USD/CAD moved past 1.38. Want me to refresh the client note?</Trans>
            </ExampleCard>
            <ExampleCard eyebrow={<Trans>Drafts</Trans>} tilt="-rotate-[0.5deg]" delay="1.2s">
              <Trans>The quarterly client review email is drafted and ready for your yes.</Trans>
            </ExampleCard>
          </div>

          <button
            type="button"
            onClick={() => navigate("/sign-up")}
            className="app-no-drag mt-10 inline-flex items-center gap-2 rounded-full bg-primary px-7 py-3.5 text-[16px] font-medium text-primary-foreground transition-transform hover:scale-[1.03] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none motion-reduce:hover:scale-100"
          >
            <Trans>Meet Nova</Trans>
            <ArrowRight size={17} strokeWidth={2} aria-hidden="true" />
          </button>
          <Link
            to="/sign-in"
            className="app-no-drag mt-4 text-[14px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            <Trans>I already have an account</Trans>
          </Link>
        </div>
      </main>
      <footer className="pb-6 text-center">
        <Eyebrow>
          <Trans>Your computer · your model · asks before anything it can't undo</Trans>
        </Eyebrow>
      </footer>
    </div>
  );
}

function ExampleCard({
  eyebrow,
  tilt,
  delay,
  children,
}: {
  eyebrow: ReactNode;
  tilt: string;
  delay: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-2xl border border-border bg-card p-4 text-start shadow-float",
        "animate-[museFloat_6s_ease-in-out_infinite] motion-reduce:animate-none",
        tilt,
      )}
      style={{ animationDelay: delay }}
    >
      <Eyebrow>{eyebrow}</Eyebrow>
      <p className="text-[14px] leading-[1.45] text-foreground">{children}</p>
    </div>
  );
}
