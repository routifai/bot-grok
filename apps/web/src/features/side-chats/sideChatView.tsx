import { userVisibleMessages } from "@superchat/core";
import { useMemo, useRef } from "react";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { useTurnRuns } from "../../pages/muse/chrome/useMuseLiveState";
import { Composer } from "../../pages/muse/conversation/Composer";
import { Transcript } from "../../pages/muse/conversation/Transcript";
import type { SideChatView } from "./SideChatSession";

const noop = () => undefined;
const noopAsync = async () => undefined;

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
    const runs = useTurnRuns(`side-chat:${bot.id}`, running);
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
        running={running}
        onLoadOlder={noop}
        onAnswer={noopAsync}
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
