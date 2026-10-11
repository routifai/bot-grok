import { Trans, useLingui } from "@lingui/react/macro";
import type { ThreadMessage } from "@superchat/contracts";
import { isSecretAskBlock, narrateTool, speechFromBlocks, spokenDecision } from "@superchat/core";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from "@superchat/ui-web";
import { useEffect, useRef, useState } from "react";
import { dictation } from "../lib/dictation";
import { speaker } from "../lib/tts";

type Phase = "listening" | "thinking" | "speaking";

/** The Conversation as the call sees it: its messages and whether a reply is being written. */
export type CallConversation = { messages: readonly ThreadMessage[]; running: boolean };

export function CallView({
  botId,
  botName,
  transcribe,
  conversation,
  onSend,
  onAnswer,
  onClose,
}: {
  botId: string;
  botName: string;
  transcribe: boolean;
  conversation: CallConversation;
  onSend: (text: string) => Promise<unknown>;
  onAnswer: (message: ThreadMessage, text: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [phase, setPhase] = useState<Phase>("listening");
  const [caption, setCaption] = useState("");
  const [heard, setHeard] = useState("");
  const [error, setError] = useState<string | null>(null);
  const phaseRef = useRef<Phase>("listening");
  const spokenMessage = useRef<string | null>(null);
  const narrated = useRef(new Set<string>());
  const closing = useRef(false);
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const askPromptRef = useRef(t`Say yes or no, or answer in a sentence.`);
  askPromptRef.current = t`Say yes or no, or answer in a sentence.`;
  const secretPromptRef = useRef(t`Hang up first, then enter the code on screen.`);
  secretPromptRef.current = t`Hang up first, then enter the code on screen.`;

  function setCallPhase(next: Phase) {
    phaseRef.current = next;
    setPhase(next);
  }

  function hangUp() {
    closing.current = true;
    dictation.stop("cancel");
    speaker.stop();
    onClose();
  }

  function interrupt() {
    if (phaseRef.current === "speaking") speaker.stop();
    else dictation.stop("cancel");
    void listen();
  }

  async function listen() {
    if (closing.current) return;
    if (pendingSecretAsk(conversationRef.current.messages)) {
      dictation.stop("cancel");
      setCallPhase("listening");
      setHeard("");
      return;
    }
    setCallPhase("listening");
    speaker.stop();
    setHeard("");
    try {
      await dictation.listen({
        mode: "endpoint",
        transcribe,
        onFinal: (text) => void handleTranscript(text),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Microphone failed`);
    }
  }

  async function handleTranscript(text: string) {
    if (closing.current || !text.trim()) {
      void listen();
      return;
    }
    dictation.stop("submit");
    const current = conversationRef.current;
    if (pendingSecretAsk(current.messages)) {
      setHeard("");
      setCaption("");
      setError(t`Hang up, then enter the code on screen.`);
      return;
    }
    setHeard(text);
    setCallPhase("thinking");
    const askMessage = openAskMessage(current.messages);
    try {
      if (askMessage) {
        const decision = spokenDecision(text);
        await onAnswer(askMessage, decision ?? text);
      } else {
        await onSend(text);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not send that`);
      void listen();
    }
  }

  useEffect(() => {
    closing.current = false;
    spokenMessage.current = null;
    narrated.current.clear();
    const unsubSpeech = speaker.subscribe((state) => {
      if (state.status === "speaking") {
        setCallPhase("speaking");
        setCaption(state.caption ?? "");
      } else if (state.status === "idle" && phaseRef.current !== "listening") {
        setCaption("");
        void listen();
      }
      if (state.error) setError(state.error);
    });
    const unsubDictation = dictation.subscribe((state) => {
      if (state.status === "listening") {
        setHeard(pendingSecretAsk(conversationRef.current.messages) ? "" : state.transcript);
      }
      if (state.error) setError(state.error);
    });
    void listen();
    return () => {
      closing.current = true;
      unsubSpeech();
      unsubDictation();
      dictation.stop("cancel");
      speaker.stop();
    };
  }, [botId]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        hangUp();
      }
      if (event.key === " " && phaseRef.current !== "listening") {
        event.preventDefault();
        interrupt();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (closing.current || phaseRef.current === "listening") return;
    const { messages, running } = conversation;
    const lastBot = [...messages].reverse().find((message) => message.role === "bot");
    if (lastBot && lastBot.id !== spokenMessage.current) {
      const text = speechFromBlocks(lastBot.blocks);
      const ask = lastBot.blocks.find(
        (block) => block.kind === "ask" && block.status !== "answered",
      );
      const secretAsk = ask && isSecretAskBlock(ask);
      if (text) {
        spokenMessage.current = lastBot.id;
        dictation.stop("cancel");
        void speaker.speak(
          secretAsk
            ? `${text}. ${secretPromptRef.current}`
            : ask
              ? `${text}. ${askPromptRef.current}`
              : text,
          {
            botId,
            messageId: lastBot.id,
          },
        );
        return;
      }
      if (!running) {
        spokenMessage.current = lastBot.id;
        void listen();
        return;
      }
    }
    if (running) {
      const phrases: string[] = [];
      let lastKey = "";
      for (const message of messages) {
        for (const block of message.blocks) {
          if (block.kind !== "progress" && block.kind !== "subagent") continue;
          const key = `${message.id}:${block.kind}:${block.kind === "subagent" ? block.status : block.text}`;
          if (narrated.current.has(key)) continue;
          const phrase =
            block.kind === "subagent"
              ? narrateTool("run_subagent")
              : (narrateTool(block.text.split(/\s+/)[0] ?? "") ?? speakableProgress(block.text));
          if (!phrase) continue;
          narrated.current.add(key);
          phrases.push(phrase);
          lastKey = key;
        }
      }
      if (phrases.length) {
        void speaker.speak(phrases.join(". "), { botId, messageId: `narrate:${lastKey}` });
      }
    }
  }, [conversation, botId]);

  useEffect(() => {
    if (!pendingSecretAsk(conversation.messages)) return;
    dictation.stop("cancel");
    setHeard("");
  }, [conversation]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) hangUp();
      }}
    >
      <DialogContent
        data-testid="call-view"
        showCloseButton={false}
        className="max-w-[420px] rounded-3xl p-6 text-center sm:max-w-[420px]"
      >
        <DialogHeader className="items-center gap-2">
          <div className="text-[13px] uppercase tracking-[0.12em] text-muted-foreground/80">
            <Trans>Call</Trans>
          </div>
          <DialogTitle className="text-[22px]">{botName}</DialogTitle>
        </DialogHeader>
        <div className="mt-1 text-[15px] text-foreground/75">
          {phase === "listening" ? (
            <Trans>Listening…</Trans>
          ) : phase === "speaking" ? (
            <Trans>Speaking…</Trans>
          ) : (
            <Trans>Working…</Trans>
          )}
        </div>
        <p className="min-h-[3.2em] text-[14.5px] leading-[1.5] text-muted-foreground">
          {phase === "listening" ? heard || t`Say something. Silence sends it.` : caption}
        </p>
        {error ? <p className="text-[13px] text-destructive">{error}</p> : null}
        <div className="mt-2 flex justify-center gap-3">
          <Button variant="outline" className="rounded-full" onClick={interrupt}>
            <Trans>Interrupt</Trans>
          </Button>
          <Button variant="destructive" className="rounded-full" onClick={hangUp}>
            <Trans>Hang up</Trans>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground/80">
          <Trans>Space interrupts · Esc hangs up</Trans>
        </p>
      </DialogContent>
    </Dialog>
  );
}

function pendingSecretAsk(messages: readonly ThreadMessage[]) {
  return openAskMessage(messages)?.blocks.some(
    (block) => block.kind === "ask" && isSecretAskBlock(block) && block.status !== "answered",
  );
}

/** The latest message holding an ask the person has not answered. */
function openAskMessage(messages: readonly ThreadMessage[]): ThreadMessage | undefined {
  return messages.findLast((message) =>
    message.blocks.some((block) => block.kind === "ask" && block.status !== "answered"),
  );
}

function speakableProgress(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 80) return null;
  return trimmed;
}
