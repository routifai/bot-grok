import type { ThreadMessage } from "@nova/contracts";
import { cn } from "@nova/ui-web";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { Transcript } from "../muse/conversation/Transcript";
import { type CardsScenario, replyTo, seedMessages } from "./cards-fixture";
import { DEV_BOT_ID, DEV_MUSE_COLOR, DEV_MUSE_NAME } from "./side-chat-fixture";

const noop = () => undefined;
const noopAsync = async () => undefined;

/**
 * Dev-only routes (`/dev/clarify`, `/dev/followups`, gated by `import.meta.env.DEV` in App.tsx,
 * like `/dev/forks`): the real Conversation transcript with a clarification card or follow-up
 * chips. Clicking sends the text as the person's message, the fixture "Muse" works for a moment
 * (`running`: chips hidden) and then answers. `?theme=light|dark` forces a theme.
 */
export function CardsPreviewPage({ scenario }: { scenario: CardsScenario }) {
  const [messages, setMessages] = useState<ThreadMessage[]>(() => seedMessages(scenario));
  const [running, setRunning] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const artifactTarget = useMemo<ArtifactTarget>(() => ({ botId: DEV_BOT_ID }), []);

  useEffect(() => {
    const theme = new URLSearchParams(window.location.search).get("theme");
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
    return () => window.clearTimeout(timer.current);
  }, []);

  const send = useCallback(
    (said: string) => {
      setMessages((current) => [
        ...current,
        {
          id: `person-${current.length}`,
          threadId: "cards",
          seq: current.length + 1,
          role: "user",
          blocks: [{ kind: "text", text: said }],
          createdAt: new Date().toISOString(),
        },
      ]);
      setRunning(true);
      timer.current = window.setTimeout(() => {
        setMessages((current) => [...current, ...replyTo(scenario, said)]);
        setRunning(false);
      }, 1200);
    },
    [scenario],
  );

  return (
    <div className="flex h-screen bg-background p-2">
      <main
        className={cn(
          "relative mx-auto flex min-h-0 w-full max-w-[860px] min-w-0 flex-1 flex-col overflow-hidden",
          "border border-line bg-panel backdrop-blur-xl md:rounded-[18px]",
        )}
      >
        <div className="flex h-14 shrink-0 items-center border-b border-line px-6">
          <h1 className="text-[15px] font-semibold">Conversation</h1>
        </div>
        <Transcript
          museMode
          botDisplayName={DEV_MUSE_NAME}
          museFace={{ color: DEV_MUSE_COLOR, identity: DEV_BOT_ID }}
          museRuns={[]}
          scrollRef={scrollRef}
          scrollRequest={null}
          onScrollRequestHandled={noop}
          artifactTarget={artifactTarget}
          messages={messages}
          olderCursor={null}
          loadingOlder={false}
          answerableAskMessageId={null}
          running={running}
          workingBots={[]}
          onLoadOlder={noop}
          onOpenBot={noop}
          onAnswer={noopAsync}
          onReact={noopAsync}
          onJumpToMessage={noop}
          onOpenPeerMessages={noop}
          peerBot={() => undefined}
          onRefresh={noopAsync}
          onBotChanged={noopAsync}
          onAddRoutine={noop}
          voiceReady={false}
          speakingMessageId={null}
          onSpeak={noop}
          onOpenComputer={noop}
          onSendCard={send}
        />
      </main>
    </div>
  );
}
