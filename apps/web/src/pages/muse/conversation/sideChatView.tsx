import { userVisibleMessages } from "@aiden/core";
import { useMemo, useRef } from "react";
import type { ArtifactTarget } from "../../../lib/artifact-open";
import { ApprovalCards } from "../asks";
import type { SideChatView } from "../chrome/SideChatSession";
import type { MuseLiveRun } from "../chrome/useMuseLiveState";
import { Composer } from "./Composer";
import { Transcript } from "./Transcript";

const noop = () => undefined;
const noopAsync = async () => undefined;
const NOT_LIVE_BOT = () => undefined;

/** The Conversation's own Transcript and Composer for a Side Chat session
 * (SideChatSession.tsx): same bubbles, Muse face, markdown, working row and scrolling, minus
 * what a text-only Side Chat doesn't have (replies, attachments, voice, a computer). */
export const sideChatView: SideChatView = {
  Approvals: ApprovalCards,
  Transcript: function SideChatTranscript({
    messages,
    running,
    leading,
    trailing,
    followSignal,
    bot,
  }) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const visible = useMemo(
      () => userVisibleMessages(messages, { includePeerReceipts: true }),
      [messages],
    );
    const runs = useMemo<MuseLiveRun[]>(
      () => (running ? [{ id: "side-chat", status: "running" }] : []),
      [running],
    );
    const artifactTarget = useMemo<ArtifactTarget>(() => ({ botId: bot.id }), [bot.id]);
    const museFace = useMemo(() => ({ color: bot.color, identity: bot.id }), [bot.color, bot.id]);
    return (
      <Transcript
        museMode
        botDisplayName={bot.name}
        museFace={museFace}
        museRuns={runs}
        leading={leading}
        trailing={trailing}
        followSignal={followSignal}
        scrollRef={scrollRef}
        scrollRequest={null}
        onScrollRequestHandled={noop}
        artifactTarget={artifactTarget}
        messages={visible}
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
        peerBot={NOT_LIVE_BOT}
        onRefresh={noopAsync}
        onBotChanged={noopAsync}
        onAddRoutine={noop}
        voiceReady={false}
        speakingMessageId={null}
        onSpeak={noop}
        onOpenComputer={noop}
      />
    );
  },
  Composer: function SideChatComposer({ placeholder, sending, onSend }) {
    return (
      <Composer
        museMode
        activeName=""
        placeholder={placeholder}
        sending={sending}
        running={false}
        onSend={onSend}
      />
    );
  },
};
