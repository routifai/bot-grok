import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@nova/chat-ui/web";
import type { ThreadMessage } from "@nova/contracts";
import { isToolActivityBlock } from "@nova/core";
import { cn } from "@nova/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";
import { formatLogTimestamp } from "./format";

/**
 * One Goal-log entry, read-only: a mono timestamp above the turn's content. Reuses
 * ChatMarkdown and the tool-activity filter the Conversation's message view uses;
 * MessageView itself (Shell.tsx) is tied to Shell state (reply, react, speak, routines…)
 * that a read-only log doesn't need.
 */
function GoalLogEntry({
  message,
  locale,
  isLast,
}: {
  message: ThreadMessage;
  locale: string;
  isLast: boolean;
}) {
  const blocks = message.blocks.filter((block) => !isToolActivityBlock(block));
  return (
    <li className={cn("relative flex gap-3", !isLast && "pb-4")}>
      <div className="flex w-2.5 shrink-0 flex-col items-center" aria-hidden="true">
        <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
        {!isLast ? <span className="mt-1.5 w-px flex-1 bg-border" /> : null}
      </div>
      <div className="min-w-0 flex-1 pb-0.5">
        <span className="font-mono text-[10.5px] tracking-[0.04em] text-muted-foreground/70">
          {formatLogTimestamp(message.createdAt, locale)}
        </span>
        <div className="mt-1.5 space-y-2 rounded-xl bg-muted px-4 py-3 text-[14px] leading-[1.5] text-foreground/90">
          {blocks.map((block, index) => {
            if (block.kind === "text" || block.kind === "progress") {
              return <ChatMarkdown key={index}>{block.text}</ChatMarkdown>;
            }
            if (block.kind === "card") {
              return (
                <dl key={index} className="space-y-0.5 text-[13px]">
                  {block.lines.map((line, lineIndex) => (
                    <div key={lineIndex} className="flex gap-2">
                      <dt className="text-muted-foreground">{line.k}</dt>
                      <dd>{line.v}</dd>
                    </div>
                  ))}
                </dl>
              );
            }
            if (block.kind === "steps") {
              return (
                <ul
                  key={index}
                  className="list-disc space-y-0.5 pl-4 text-[13px] text-muted-foreground"
                >
                  {block.steps.map((step, stepIndex) => (
                    <li key={stepIndex}>{step.label}</li>
                  ))}
                </ul>
              );
            }
            return null;
          })}
        </div>
      </div>
    </li>
  );
}

/** Read-only view of what the Muse did on a Goal, as a quiet timeline. No composer. */
export function GoalLog({ goalId }: { goalId: string }) {
  const { t, i18n } = useLingui();
  const [messages, setMessages] = useState<ThreadMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setMessages(null);
    setError(null);
    void rpc.goals
      .log({ goalId })
      .then((page) => {
        if (current) setMessages(page.messages);
      })
      .catch(() => {
        if (current) setError(t`Could not load the Goal log`);
      });
    return () => {
      current = false;
    };
  }, [goalId, t]);

  if (error) return <p className="text-[13px] text-destructive">{error}</p>;
  if (messages === null) {
    return (
      <p className="text-[13px] text-muted-foreground">
        <Trans>Loading…</Trans>
      </p>
    );
  }
  const visible = messages.filter(
    (message) => message.blocks.filter((block) => !isToolActivityBlock(block)).length > 0,
  );
  if (visible.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground">
        <Trans>Nothing yet</Trans>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-testid="goal-log">
      <ol>
        {visible.map((message, index) => (
          <GoalLogEntry
            key={message.id}
            message={message}
            locale={i18n.locale}
            isLast={index === visible.length - 1}
          />
        ))}
      </ol>
    </div>
  );
}
