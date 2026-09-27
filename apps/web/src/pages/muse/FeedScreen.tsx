import { Trans } from "@lingui/react/macro";

/**
 * Stub for F5/F6 (Feed + Ideas): open Asks pinned, then Posts, with Ideas at the
 * bottom. `onSendIdea` is wired by the shell already: tapping an Idea chip (once
 * F6 renders one) sends its text in the Conversation and switches to it.
 */
export function FeedScreen(_props: { botId: string; onSendIdea: (text: string) => void }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-6">
      <h1 className="text-xl font-semibold text-foreground">
        <Trans>Feed</Trans>
      </h1>
    </div>
  );
}
