import { Trans } from "@lingui/react/macro";
import { MessageSquare } from "lucide-react";
import type { ReactNode } from "react";
import { SuperchatLogo } from "../../../components/SuperchatLogo";
import { ContourGround } from "./ContourGround";
import { SettingsButton } from "./Dock";

/**
 * The home screen: the mark and wordmark top-left, the dock on the left, the greeting over the
 * composer in the middle, recent chats bottom-right and Settings bottom-left. It sits over the
 * Conversation shell until something opens (a send, a chat, a fork).
 */
export function Home({
  personName,
  dock,
  composer,
  recent,
  onOpenSettings,
  onOpenConversation,
}: {
  personName: string;
  dock: ReactNode;
  composer: ReactNode;
  recent: ReactNode;
  onOpenSettings: () => void;
  onOpenConversation: () => void;
}) {
  const name = personName.trim().split(/\s+/)[0] ?? "";
  return (
    <div
      data-testid="home"
      className="absolute inset-0 z-30 flex flex-col gap-5 overflow-y-auto bg-window px-4 py-6 text-foreground md:px-8 md:py-7"
    >
      <ContourGround />
      <header className="relative flex items-center justify-between gap-3">
        <SuperchatLogo />
        <button
          type="button"
          onClick={onOpenConversation}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3.5 text-[14px] font-medium text-foreground transition-colors hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <MessageSquare size={18} strokeWidth={1.7} aria-hidden="true" />
          <Trans>Conversation</Trans>
        </button>
      </header>
      <div className="relative flex flex-1 flex-wrap items-stretch gap-8">
        <div className="flex flex-none items-center self-start md:self-center">{dock}</div>
        <main className="flex min-h-[300px] min-w-0 flex-[999_1_560px] flex-col items-center justify-center gap-8 md:pb-80 md:pe-8 xl:pb-24 xl:pe-[400px]">
          <h1
            className="max-w-[680px] text-center text-[34px] leading-[1.12] font-medium tracking-[-0.03em] text-balance text-foreground/90 md:text-[52px]"
            dir="auto"
          >
            {name ? (
              <Trans>
                Hi {name}, what can superchat{" "}
                <strong className="font-bold text-foreground">build with you?</strong>
              </Trans>
            ) : (
              <Trans>
                What can superchat{" "}
                <strong className="font-bold text-foreground">build with you?</strong>
              </Trans>
            )}
          </h1>
          <div className="w-full max-w-[780px]">{composer}</div>
        </main>
      </div>
      <footer className="pointer-events-none relative z-10 flex flex-wrap items-end justify-between gap-4 md:absolute md:inset-x-8 md:bottom-7 [&>*]:pointer-events-auto">
        <SettingsButton onClick={onOpenSettings} />
        {recent}
      </footer>
    </div>
  );
}
