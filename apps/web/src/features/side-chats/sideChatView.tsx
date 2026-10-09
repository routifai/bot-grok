import { userVisibleMessages } from "@nova/core";
import { useEffect, useMemo, useRef } from "react";
import type { ArtifactTarget } from "../../lib/artifact-open";
import type { MuseLiveRun } from "../../pages/muse/chrome/useMuseLiveState";
import { Composer } from "../../pages/muse/conversation/Composer";
import { Transcript } from "../../pages/muse/conversation/Transcript";
import type { SideChatView } from "./SideChatSession";

const noop = () => undefined;
const noopAsync = async () => undefined;
/** A side chat only says "running", not since when, so the first time we saw it running is
 * remembered here (outliving the pane): switching to another chat and back keeps the timer. */
const sideChatRunStarts = new Map<string, number>();

const NOT_LIVE_BOT = () => undefined;

/** The Conversation's own Transcript and Composer for a Side Chat session
 * (SideChatSession.tsx): same bubbles, Muse face, markdown, working row and scrolling, minus
 * what a text-only Side Chat doesn't have (replies, attachments, voice, a computer). The
 * waiting approvals (`Approvals`) come from the approvals capability; the shell adds them. */
export const sideChatView: Omit<SideChatView, "Approvals"> = {
  Transcript: function SideChatTranscript({
    messages,
    running,
    leading,
    trailing,
    followSignal,
    scrollRequest,
    bot,
  }) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const visible = useMemo(
      () => userVisibleMessages(messages, { includePeerReceipts: true }),
      [messages],
    );
    const runs = useMemo<MuseLiveRun[]>(() => {
      if (!running) return [];
      const key = `side-chat:${bot.id}`;
      let startedAtMs = sideChatRunStarts.get(key);
      if (startedAtMs === undefined) {
        startedAtMs = Date.now();
        sideChatRunStarts.set(key, startedAtMs);
      }
      return [{ id: "side-chat", status: "running", startedAtMs }];
    }, [running, bot.id]);
    useEffect(() => {
      if (!running) sideChatRunStarts.delete(`side-chat:${bot.id}`);
    }, [running, bot.id]);
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
        scrollRequest={scrollRequest ?? null}
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
