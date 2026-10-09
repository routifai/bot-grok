import { Trans } from "@lingui/react/macro";
import { useEffect } from "react";
import { authClient } from "../lib/auth";
import { WelcomeFrame } from "./welcome/WelcomeFrame";

const FIRST_CHECK_MS = 5_000;
const LONGEST_WAIT_MS = 60_000;

/**
 * Rechecks the session with growing gaps (5s, 10s, ... up to a minute), and not at all while the
 * tab is hidden; coming back to the tab checks at once. It never polls on a fixed beat forever.
 */
function useApprovalCheck(refetch: () => Promise<void>) {
  useEffect(() => {
    let delay = FIRST_CHECK_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const schedule = () => {
      if (stopped || document.visibilityState === "hidden") return;
      timer = setTimeout(() => void check(), delay);
    };
    const check = async () => {
      await refetch().catch(() => undefined);
      delay = Math.min(delay * 2, LONGEST_WAIT_MS);
      schedule();
    };
    const wake = () => {
      if (document.visibilityState === "hidden") return;
      clearTimeout(timer);
      delay = FIRST_CHECK_MS;
      void check();
    };
    schedule();
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [refetch]);
}

/** Pending accounts can sign in but own nothing yet: no space, Computer or model access. */
export function PendingApprovalPage({ refetch }: { refetch: () => Promise<void> }) {
  // The admin's approval takes effect on the next session read.
  useApprovalCheck(refetch);
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
