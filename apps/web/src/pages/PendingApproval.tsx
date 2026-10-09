import { Trans } from "@lingui/react/macro";
import { authClient } from "../lib/auth";
import { useVisiblePoll } from "../lib/use-visible-poll";
import { WelcomeFrame } from "./welcome/WelcomeFrame";

/** Pending accounts can sign in but own nothing yet: no space, Computer or model access. */
export function PendingApprovalPage({ refetch }: { refetch: () => Promise<void> }) {
  // The admin's approval takes effect on the next session read.
  useVisiblePoll(refetch, 5_000);
  return (
    <WelcomeFrame title={<Trans>Waiting for approval</Trans>}>
      <p role="status" className="text-center text-welcome-night-ink-2">
        <Trans>You can come back later.</Trans>
      </p>
      <button
        type="button"
        onClick={() => void authClient.signOut()}
        className="mt-8 text-sm font-medium text-welcome-night-ink underline-offset-4 hover:underline"
      >
        <Trans>Sign out</Trans>
      </button>
    </WelcomeFrame>
  );
}

/** Accounts created before approvals existed have no status and count as active. */
export function isPendingApproval(user: unknown): boolean {
  return (user as { status?: unknown } | null | undefined)?.status === "pending";
}
