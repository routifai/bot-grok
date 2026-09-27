import { Trans } from "@lingui/react/macro";

/** Stub for F2 (Goals screen): list of Goals, plan, and open Proposal. */
export function GoalsScreen(_props: { botId: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-6">
      <h1 className="text-xl font-semibold text-foreground">
        <Trans>Goals</Trans>
      </h1>
    </div>
  );
}
