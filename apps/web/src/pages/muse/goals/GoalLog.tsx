import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ThreadMessage } from "@rakazo/contracts";
import { isToolActivityBlock } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../../../lib/rpc";

/**
 * One Goal-log message, read-only. Reuses ChatMarkdown and the tool-activity filter the
 * Conversation's message view uses; MessageView itself (Shell.tsx) is tied to Shell state
 * (reply, react, speak, routines…) that a read-only log doesn't need.
 */
function GoalLogMessage({ message }: { message: ThreadMessage }) {
  const blocks = message.blocks.filter((block) => !isToolActivityBlock(block));
  if (blocks.length === 0) return null;
  return (
    <div className="flex w-fit max-w-full justify-start">
      <div className="max-w-full space-y-2 rounded-[20px] bg-muted px-[18px] py-3 text-[14.5px] leading-[1.5] text-foreground/90">
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
  );
}

/** Read-only view of a Goal's own thread: every step the Muse took on it. No composer. */
export function GoalLog({ goalId }: { goalId: string }) {
  const { t } = useLingui();
  const [messages, setMessages] = useState<ThreadMessage[] | null>(null);
  const [olderCursor, setOlderCursor] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setMessages(null);
    setError(null);
    setOlderCursor(null);
    void rpc.goals
      .log({ goalId })
      .then((page) => {
        if (current !== generation.current) return;
        setMessages(page.messages);
        setOlderCursor(page.olderCursor);
      })
      .catch(() => {
        if (current !== generation.current) return;
        setError(t`Could not load the Goal log`);
      });
    return () => {
      generation.current += 1;
    };
  }, [goalId, t]);

  async function loadOlder() {
    if (olderCursor == null || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await rpc.goals.log({ goalId, before: olderCursor });
      setMessages((current) => [...page.messages, ...(current ?? [])]);
      setOlderCursor(page.olderCursor);
    } catch {
      setError(t`Could not load more`);
    } finally {
      setLoadingMore(false);
    }
  }

  if (error) return <p className="text-[13px] text-destructive">{error}</p>;
  if (messages === null) {
    return (
      <p className="text-[13px] text-muted-foreground">
        <Trans>Loading…</Trans>
      </p>
    );
  }
  if (messages.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground">
        <Trans>Nothing yet</Trans>
      </p>
    );
  }
  return (
    <div className="space-y-2" data-testid="goal-log">
      {olderCursor != null ? (
        <Button variant="ghost" size="xs" disabled={loadingMore} onClick={() => void loadOlder()}>
          {loadingMore ? <Trans>Loading…</Trans> : <Trans>Load older</Trans>}
        </Button>
      ) : null}
      {messages.map((message) => (
        <GoalLogMessage key={message.id} message={message} />
      ))}
    </div>
  );
}
