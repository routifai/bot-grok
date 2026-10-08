import { ChatMarkdown } from "@aiden/chat-ui/web";
import type { ThreadMessage } from "@aiden/contracts";
import { ENGINE_ERROR_NOTE, isEngineErrorText, isToolActivityBlock } from "@aiden/core";
import { BotAvatar, Button, cn, resolvePersonaColorDef } from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { memo, useMemo } from "react";
import { ArtifactFileCard } from "../../../components/ArtifactFileCard";

import { AskCard } from "../../../components/AskCard";
import { CollaborationMarker } from "../../../components/ai/CollaborationMarker";
import { CloudAgentCard } from "../../../components/CloudAgentCard";
import { ReplyCardBlockView } from "../../../components/cards/ReplyCard";
import { SkillDraftCard } from "../../../components/teach/SkillDraftCard";
import type { ArtifactTarget } from "../../../lib/artifact-open";
import { messageProviderLabel } from "../../../lib/messaging";
import {
  AppConnectCard,
  ArtifactImage,
  CanvasBlockView,
  ChartBlockView,
  ChoiceCard,
  McpApprovalCard,
} from "../../shell/message-cards";
import { FirstRunHint } from "../intro";
import { HelperTracker } from "./HelperTracker";
import { accessibleReplyExcerpt, previewMessageText } from "./messageText";
import { FALLBACK_BOT_COLOR } from "./shared";

/** Muse mode only: one quiet line for a tool-activity block (docs/muse/DESIGN.md "Conversation"). */
function ToolActivityStep({ block }: { block: ThreadMessage["blocks"][number] }) {
  const label =
    block.kind === "steps"
      ? block.steps.map((step) => step.label).join(" · ")
      : "text" in block
        ? block.text
        : undefined;
  if (!label) return null;
  return (
    <div className="flex items-center gap-1.5 py-0.5 text-[12.5px] text-muted-foreground/70">
      <span aria-hidden="true" className="size-1 shrink-0 rounded-full bg-muted-foreground/50" />
      <span className="truncate" dir="auto">
        {label}
      </span>
    </div>
  );
}

export const MessageView = memo(function MessageView({
  museMode,
  botDisplayName,
  artifactTarget,
  canAnswer,
  message,
  onAnswer,
  onOpenBot,
  onOpenPeerMessages,
  speakerName,
  memberName,
  peerBot,
  replyPreview,
  replyToMessageId,
  onJumpToMessage,
  onRefresh,
  onBotChanged,
  onAddRoutine,
  voiceReady,
  speaking,
  onSpeak,
  onOpenComputer,
}: {
  museMode?: boolean;
  /** Muse mode: the Muse's own name, for first-run hint copy (`FirstRunHint`). */
  botDisplayName?: string;
  artifactTarget: ArtifactTarget;
  canAnswer: boolean;
  message: ThreadMessage;
  onAnswer: (message: ThreadMessage, text: string, username?: string) => Promise<void>;
  onOpenBot: (botId: string) => void;
  onOpenPeerMessages: (peer: { peerBotId: string; peerBotName: string }) => void;
  speakerName?: string;
  memberName?: (botId: string | undefined) => string | undefined;
  peerBot: (botId: string) => { color: string; status?: string } | undefined;
  replyPreview?: ThreadMessage;
  replyToMessageId?: string;
  onJumpToMessage?: (messageId: string) => void;
  onRefresh: () => Promise<void>;
  onBotChanged: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
  voiceReady: boolean;
  speaking: boolean;
  onSpeak: () => void;
  onOpenComputer: (botId?: string) => void;
}) {
  const { t } = useLingui();
  /** The engine sends a failure's code, never its wording: the copy is ours. */
  const errorNote = (code: string) => {
    switch (code) {
      case "provider_unavailable":
        return t`I lost the connection. Try again.`;
      case "timeout":
        return t`That took too long. Try again.`;
      case "rate_limited":
      case "overloaded":
        return t`The model is busy. Try again in a moment.`;
      case "insufficient_credit":
        return t`The model account is out of credit.`;
      case "auth_failed":
        return t`The model refused my key.`;
      case "context_too_long":
        return t`This conversation is too long for the model.`;
      case "sandbox_unavailable":
        return t`My computer restarted. Try again.`;
      default:
        return t`Something went wrong on my side. Try again.`;
    }
  };
  const isNarration =
    message.role === "bot" &&
    message.blocks.length > 0 &&
    message.blocks.every(
      (block) =>
        block.kind === "text" ||
        block.kind === "progress" ||
        block.kind === "steps" ||
        // An added fork's summary is drawn under the message (forks/ForkUnderMessage.tsx).
        block.kind === "fork_summary",
    );
  const isLive = message.id.startsWith("progress:");
  const quoteMessageId = message.id.includes(":") ? undefined : message.id;
  const visibleNarrationBlocks = message.blocks.filter(
    (block) => museMode || !isToolActivityBlock(block),
  );
  const parentJumpId = replyPreview?.id ?? replyToMessageId;
  const speakerBot = message.botId ? peerBot?.(message.botId) : undefined;
  const speakerColorDef = useMemo(
    () => resolvePersonaColorDef(message.botId ?? "bot", speakerBot?.color),
    [message.botId, speakerBot?.color],
  );
  const messageContext = (
    <>
      {speakerName ? (
        <div
          className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold tracking-tight"
          dir="auto"
          style={{ color: speakerColorDef.light }}
        >
          <BotAvatar
            color={speakerBot?.color ?? FALLBACK_BOT_COLOR}
            identity={message.botId}
            size={22}
          />
          {speakerName}
        </div>
      ) : null}
      {parentJumpId ? (
        <button
          type="button"
          data-testid="reply-parent-preview"
          // Name the action and a short excerpt; a bare action label would
          // hide the quote, and an unbounded quote can be thousands of chars.
          aria-label={
            message.replyQuote
              ? t`Jump to replied message: “${accessibleReplyExcerpt(message.replyQuote)}”`
              : replyPreview
                ? t`Jump to replied message: ${accessibleReplyExcerpt(previewMessageText(replyPreview))}`
                : t`Jump to replied message`
          }
          onClick={() => onJumpToMessage?.(parentJumpId)}
          className="mb-2 block max-w-[74%] truncate rounded-[14px] border border-border bg-background px-3 py-2 text-start text-[12.5px] text-muted-foreground hover:border-border hover:text-foreground/75"
          dir="auto"
        >
          {message.replyQuote
            ? `“${message.replyQuote}”`
            : replyPreview
              ? previewMessageText(replyPreview)
              : t`Earlier message`}
        </button>
      ) : null}
    </>
  );
  if (isNarration) {
    if (visibleNarrationBlocks.length === 0) return null;
    return (
      <>
        {messageContext}
        <div className="flex w-fit max-w-full justify-start">
          <div
            data-testid="message-bot-bubble"
            className={cn(
              "max-w-full space-y-2.5",
              museMode
                ? "text-[15.5px] leading-[1.6] text-foreground"
                : "rounded-[20px] bg-muted px-[18px] py-3 text-[15.5px] leading-[1.5] text-foreground/90",
            )}
            dir="auto"
          >
            {visibleNarrationBlocks.map((block, i) => {
              if (block.kind === "text" || (block.kind === "progress" && !block.activity)) {
                return (
                  <div
                    key={i}
                    data-quote-message-id={block.kind === "text" ? quoteMessageId : undefined}
                  >
                    <ChatMarkdown streaming={block.kind === "progress"}>{block.text}</ChatMarkdown>
                  </div>
                );
              }
              if (museMode && isToolActivityBlock(block)) {
                return <ToolActivityStep key={i} block={block} />;
              }
              return null;
            })}
            {!isLive && voiceReady && message.blocks.some((block) => block.kind === "text") ? (
              <button
                type="button"
                aria-label={speaking ? t`Stop speaking` : t`Speak this reply`}
                onClick={onSpeak}
                className="text-[12px] text-muted-foreground hover:text-foreground"
              >
                {speaking ? <Trans>Stop</Trans> : <Trans>Speak</Trans>}
              </button>
            ) : null}
          </div>
        </div>
      </>
    );
  }
  return (
    <>
      {messageContext}
      {message.blocks.map((block, i) => {
        if (isToolActivityBlock(block)) {
          return museMode ? <ToolActivityStep key={i} block={block} /> : null;
        }
        if (block.kind === "handoff") {
          const from = memberName?.(block.fromBotId) ?? t`bot`;
          const to = memberName?.(block.toBotId) ?? t`bot`;
          return (
            <div
              key={i}
              className="flex items-center justify-center gap-2 py-1 text-[13.5px] text-muted-foreground"
            >
              <span>
                ↪ {to} ← {from}
              </span>
              <span>{block.text}</span>
            </div>
          );
        }
        if (block.kind === "bot_message_sent" || block.kind === "bot_message_received") {
          const sent = block.kind === "bot_message_sent";
          const peer = sent ? block.toBotName : block.fromBotName;
          const peerBotId = sent ? block.toBotId : block.fromBotId;
          const label = sent ? t`Messaged ${peer}` : t`Message from ${peer}`;
          return (
            <CollaborationMarker
              key={i}
              ariaLabel={label}
              color={peerBot(peerBotId)?.color ?? FALLBACK_BOT_COLOR}
              identity={peerBotId}
              label={label}
              onClick={() => onOpenPeerMessages({ peerBotId, peerBotName: peer })}
            />
          );
        }
        if (block.kind === "channel_message") {
          return (
            <div
              key={i}
              className="flex items-center justify-center gap-2 py-1 text-[13.5px] text-muted-foreground"
            >
              <span>
                {messageProviderLabel(block.provider, block.transport)} · {block.fromLabel}:{" "}
                {block.text}
              </span>
            </div>
          );
        }
        if (block.kind === "meta") {
          return (
            <div
              key={i}
              className="flex items-center justify-center gap-2 py-1 text-[13.5px] text-muted-foreground"
            >
              <span className="text-warning">◷</span>
              <span>{block.text}</span>
            </div>
          );
        }
        if (block.kind === "progress") {
          return (
            <div key={i} className="flex w-fit max-w-full justify-start">
              <div
                data-testid="message-bot-bubble"
                className={cn(
                  "max-w-full",
                  museMode
                    ? "text-[15.5px] leading-[1.6] text-foreground"
                    : "rounded-[20px] bg-muted px-[18px] py-3 text-[15.5px] leading-[1.5] text-foreground/90",
                )}
                dir="auto"
              >
                <ChatMarkdown streaming>{block.text}</ChatMarkdown>
              </div>
            </div>
          );
        }
        if (block.kind === "subagent") {
          const running = block.status === "running";
          const failed = block.status === "failed";
          return (
            <div
              key={i}
              className="w-[min(420px,90%)] rounded-[18px] border border-border bg-muted px-[18px] py-4"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-[15px] font-medium text-foreground" dir="auto">
                  {block.name}
                </span>
                <span
                  className={`rounded-full px-[11px] py-1 text-[13px] ${
                    failed
                      ? "bg-destructive/15 text-destructive"
                      : running
                        ? "bg-warning/15 text-warning"
                        : "bg-success/15 text-success"
                  }`}
                  style={{
                    animation: running ? "rkPulse 1.2s ease-in-out infinite" : undefined,
                  }}
                >
                  {running ? <Trans>subagent</Trans> : block.status}
                </span>
              </div>
              <div className="mt-2 text-[13.5px] text-muted-foreground">{block.task}</div>
              {block.progress || block.result ? (
                <div className="mt-2.5 text-[14.5px] leading-[1.5] text-foreground/75">
                  <ChatMarkdown streaming={running}>
                    {block.result || block.progress || ""}
                  </ChatMarkdown>
                </div>
              ) : null}
            </div>
          );
        }
        if (block.kind === "child_bot") {
          const removed = block.status === "deleted" || block.status === "archived";
          return (
            <button
              key={i}
              type="button"
              disabled={removed}
              onClick={() => onOpenBot(block.botId)}
              className="w-[min(340px,90%)] rounded-[18px] border border-border bg-muted px-[18px] py-4 text-start disabled:opacity-60"
            >
              <div className="flex items-center justify-between">
                <span className="text-[15px] font-medium text-foreground" dir="auto">
                  {block.name}
                </span>
                <span
                  className={`rounded-full px-[11px] py-1 text-[13px] ${
                    removed ? "bg-destructive/15 text-destructive" : "bg-success/15 text-success"
                  }`}
                >
                  {block.status === "archived" ? (
                    <Trans>archived</Trans>
                  ) : block.status === "deleted" ? (
                    <Trans>deleted</Trans>
                  ) : (
                    <Trans>bot</Trans>
                  )}
                </span>
              </div>
              <div className="mt-2 text-[14.5px] leading-[1.5] text-foreground/75" dir="auto">
                {removed
                  ? block.status === "archived"
                    ? t`Archived. Chat, memory, and files kept.`
                    : t`Removed with chat, computer, and memory.`
                  : block.title || t`Opened its thread.`}
              </div>
            </button>
          );
        }
        if (block.kind === "choice") {
          const botId = "botId" in artifactTarget ? artifactTarget.botId : message.botId;
          if (!botId) return null;
          return <ChoiceCard key={i} botId={botId} block={block} onBotChanged={onBotChanged} />;
        }
        if (block.kind === "app_connect") {
          const botId = "botId" in artifactTarget ? artifactTarget.botId : message.botId;
          if (!botId) return null;
          return (
            <div key={i} className="flex justify-start py-1">
              <AppConnectCard botId={botId} block={block} />
            </div>
          );
        }
        if (block.kind === "chart") {
          return (
            <div key={i} className="flex justify-start">
              <ChartBlockView name={block.name} spec={block.spec} data={block.data} />
            </div>
          );
        }
        if (block.kind === "canvas") {
          return (
            <div key={i} className="flex justify-start">
              <CanvasBlockView
                block={block}
                disabled={!canAnswer}
                onAnswer={(value) => onAnswer(message, value)}
              />
            </div>
          );
        }
        if (block.kind === "mcp_approval") {
          return (
            <div key={i} className="flex justify-start">
              <McpApprovalCard
                botId={"botId" in artifactTarget ? artifactTarget.botId : message.botId}
                name={block.name}
                serverId={block.serverId}
                transport={block.transport}
                endpoint={block.endpoint}
                needsOAuth={block.needsOAuth}
              />
            </div>
          );
        }
        if (block.kind === "image") {
          return (
            <div
              key={i}
              className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <ArtifactImage
                target={artifactTarget}
                artifactId={block.artifactId}
                name={block.name}
              />
            </div>
          );
        }
        if (block.kind === "file") {
          return (
            <div
              key={i}
              className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <ArtifactFileCard
                target={artifactTarget}
                artifactId={block.artifactId}
                name={block.name}
                mimeType={block.mimeType}
                size={block.size}
                museMode={museMode}
              />
            </div>
          );
        }
        if (block.kind === "error") {
          return (
            <p
              key={i}
              data-testid="message-error-note"
              className="self-center py-1 text-center text-[12.5px] text-muted-foreground"
            >
              {errorNote(block.code)}
            </p>
          );
        }
        if (block.kind === "text" && message.role === "user") {
          return (
            <div key={i} className="flex w-fit max-w-full justify-end">
              <div
                data-testid="message-user-bubble"
                data-quote-message-id={quoteMessageId}
                className={cn(
                  "max-w-full whitespace-pre-wrap wrap-anywhere text-chat-user-foreground",
                  museMode
                    ? "rounded-[20px] rounded-ee-[6px] bg-bubble px-4 py-2.5 text-[15.5px] leading-[1.6]"
                    : "rounded-[20px] bg-chat-user px-[18px] py-3 text-[15.5px] leading-[1.45]",
                )}
                dir="auto"
              >
                {block.text}
              </div>
            </div>
          );
        }
        if (block.kind === "text" && isEngineErrorText(block.text)) {
          return (
            <p
              key={i}
              data-testid="message-error-note"
              className="self-center py-1 text-center text-[12.5px] text-muted-foreground"
            >
              {ENGINE_ERROR_NOTE}
            </p>
          );
        }
        if (block.kind === "text") {
          return (
            <div key={i} className="flex w-fit max-w-full justify-start">
              <div
                data-testid="message-bot-bubble"
                className={cn(
                  "max-w-full",
                  museMode
                    ? "text-[15.5px] leading-[1.6] text-foreground"
                    : "rounded-[20px] bg-muted px-[18px] py-3 text-[15.5px] leading-[1.5] text-foreground/90",
                )}
                dir="auto"
              >
                <div data-quote-message-id={quoteMessageId}>
                  <ChatMarkdown>{block.text}</ChatMarkdown>
                </div>
                {voiceReady ? (
                  <button
                    type="button"
                    aria-label={speaking ? t`Stop speaking` : t`Speak this reply`}
                    onClick={onSpeak}
                    className="mt-2 text-[12px] text-muted-foreground hover:text-foreground"
                  >
                    {speaking ? <Trans>Stop</Trans> : <Trans>Speak</Trans>}
                  </button>
                ) : null}
              </div>
            </div>
          );
        }
        if (block.kind === "card") {
          return (
            <div key={i} className="flex justify-start">
              <div className="flex flex-col gap-2 rounded-[20px] bg-muted px-5 py-4">
                {block.lines.map((line) => (
                  <div key={line.k} className="flex items-baseline gap-2.5 text-[15px]">
                    <span className="text-success">✓</span>
                    <span className="font-semibold text-white">{line.k}</span>
                    <span className="text-muted-foreground">→</span>
                    <span>{line.v}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        }
        if (block.kind === "ask") {
          const isProposal = block.actions?.some((action) => action.id === "accept") ?? false;
          if (!museMode || !isProposal) {
            return (
              <AskCard
                key={i}
                block={block}
                canAnswer={canAnswer}
                onAnswer={(text, username) => onAnswer(message, text, username)}
              />
            );
          }
          return (
            <FirstRunHint
              key={i}
              hintKey="proposal-card"
              text={t`Start it, and ${botDisplayName ?? "Nova"} works on it in the background.`}
            >
              <AskCard
                block={block}
                canAnswer={canAnswer}
                onAnswer={(text, username) => onAnswer(message, text, username)}
              />
            </FirstRunHint>
          );
        }
        if (block.kind === "reply_card") {
          return <ReplyCardBlockView key={i} block={block} messageId={message.id} index={i} />;
        }
        if (block.kind === "cloud_agent") return <CloudAgentCard key={i} block={block} />;
        if (block.kind === "helper") {
          const botId = "botId" in artifactTarget ? artifactTarget.botId : message.botId;
          if (!botId) return null;
          return (
            <HelperTracker key={i} botId={botId} helperId={block.helperId} title={block.title} />
          );
        }
        if (block.kind === "skill_draft") {
          return (
            <div key={i} className="flex justify-start">
              <SkillDraftCard block={block} onRefresh={onRefresh} onAddRoutine={onAddRoutine} />
            </div>
          );
        }
        if (block.kind === "computer") {
          return (
            <div
              key={i}
              data-testid="computer-card"
              className="w-[340px] rounded-[18px] border border-border bg-muted px-[18px] py-4"
            >
              <div className="flex items-center justify-between">
                <span className="text-[15px] font-medium text-foreground">
                  <Trans>Computer</Trans>
                </span>
                <span
                  className={
                    block.state === "Needs you"
                      ? "rounded-full bg-warning/15 px-[11px] py-1 text-[13px] text-warning"
                      : "rounded-full bg-success/15 px-[11px] py-1 text-[13px] text-success"
                  }
                >
                  {block.state}
                </span>
              </div>
              <div className="my-2.5 text-[14.5px] leading-[1.5] text-foreground/75">
                <ChatMarkdown>{block.text}</ChatMarkdown>
              </div>
              <Button
                type="button"
                size="sm"
                data-testid="computer-card-open"
                onClick={() => onOpenComputer(message.botId)}
              >
                <Trans>Open</Trans>
              </Button>
            </div>
          );
        }
        return null;
      })}
    </>
  );
});
