import type { ThreadMessage } from "@superchat/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { watchFamily } from "../../../lib/family-stream";
import { rpc } from "../../../lib/rpc";

/** Where an ask goes and which saved file it is about. */
export type AskArtifact = {
  id: string;
  name: string;
  version: number;
  /** The Muse that owns the artifact; its Conversation receives the request. */
  botId: string;
};

export type AskStatus =
  | { kind: "idle" }
  | { kind: "sending"; asked: string }
  | { kind: "editing"; asked: string }
  | { kind: "updated"; asked: string; version: number }
  | { kind: "replied"; asked: string; reply: string }
  | { kind: "failed"; asked: string; message: string };

/** How long a turn that ended may still be followed by its version landing (the views poll). */
const VERSION_GRACE_MS = 6000;
const REPLY_MAX = 220;

/** The plain text of the newest reply in a transcript page. */
export function lastReplyText(messages: readonly ThreadMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "bot") continue;
    const text = message.blocks
      .map((block) => (block.kind === "text" ? block.text : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) return text.length > REPLY_MAX ? `${text.slice(0, REPLY_MAX - 1)}…` : text;
  }
  return "";
}

/**
 * Asks the Muse to change an artifact in place, from wherever the artifact is open: the kind's
 * context block (what is selected, the hard scope) goes ahead of the person's words straight to the
 * Muse's Conversation. The status follows the turn: editing until a newer version of the artifact
 * is on screen (`version` grows), or, when the turn ends without one, the Muse's last reply.
 */
export function useArtifactAsk({
  artifact,
  contextBlock,
}: {
  artifact: AskArtifact | null;
  /** The kind's request block for the current selection; "" for none. */
  contextBlock: () => string | Promise<string>;
}) {
  const [status, setStatus] = useState<AskStatus>({ kind: "idle" });
  const statusRef = useRef(status);
  statusRef.current = status;
  const base = useRef(0);
  const botId = artifact?.botId;
  const artifactId = artifact?.id ?? "";
  const version = artifact?.version ?? 0;

  // A newer version on screen while asking is the answer. After a reply, a later version may be
  // anyone's (a Helper's, a hand edit): the reply is stale, so the line clears.
  useEffect(() => {
    const current = statusRef.current;
    if ((current.kind === "editing" || current.kind === "sending") && version > base.current) {
      setStatus({ kind: "updated", asked: current.asked, version });
    } else if (current.kind === "replied" && version > base.current) {
      setStatus({ kind: "idle" });
    }
  }, [version]);

  // The turn ended: if no version follows soon, show why with the Muse's reply.
  useEffect(() => {
    if (!botId || status.kind !== "editing") return;
    let timer: number | undefined;
    let cancelled = false;
    const stop = watchFamily(botId, (event) => {
      if (event.type !== "turnDone" || event.chatId !== botId) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        // A version saved but not on screen yet (the view's poll is paused in a hidden tab):
        // keep waiting for it rather than reporting no change.
        const newest = await rpc.artifacts
          .listVersions({ familyId: artifactId })
          .then((list) => list[0]?.version ?? 0)
          .catch(() => 0);
        if (cancelled || newest > base.current) return;
        const reply = await rpc.chats
          .transcript({ botId })
          .then((page) => lastReplyText(page.messages))
          .catch(() => "");
        const current = statusRef.current;
        if (cancelled || current.kind !== "editing") return;
        setStatus({ kind: "replied", asked: current.asked, reply });
      }, VERSION_GRACE_MS);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      stop();
    };
  }, [botId, artifactId, status.kind]);

  const send = useCallback(
    async (words: string, savedVersion?: number) => {
      const asked = words.trim();
      if (!botId || !asked) return false;
      // The newest saved version (one just saved by hand may not be on screen yet) is the base.
      base.current = Math.max(version, savedVersion ?? 0);
      setStatus({ kind: "sending", asked });
      try {
        const block = await contextBlock();
        await rpc.chats.send({ botId, text: block ? `${block}\n\n${asked}` : asked });
        setStatus((current) => (current.kind === "sending" ? { kind: "editing", asked } : current));
        return true;
      } catch (error) {
        setStatus({
          kind: "failed",
          asked,
          message: error instanceof Error ? error.message : "",
        });
        return false;
      }
    },
    [botId, contextBlock, version],
  );

  const stop = useCallback(async () => {
    if (!botId) return;
    setStatus({ kind: "idle" });
    await rpc.chats.interrupt({ botId }).catch(() => undefined);
  }, [botId]);

  const dismiss = useCallback(() => setStatus({ kind: "idle" }), []);

  return { status, send, stop, dismiss, available: !!botId };
}
