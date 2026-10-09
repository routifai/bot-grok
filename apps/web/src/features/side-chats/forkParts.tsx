import { i18n } from "@lingui/core";
import { Trans } from "@lingui/react/macro";
import { cn } from "@nova/ui-web";
import type { ForkTone } from "./forkModel";
import { FORK_TONE_CLASS } from "./forkModel";

/** The fork mark: a line that branches off to the right. */
export function BranchIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      aria-hidden="true"
      className={cn("shrink-0", className)}
    >
      <path
        d="M4 2v10M4 7c0-2.5 2-3.5 4.5-3.5H11M9.5 2 11.5 3.5 9.5 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** iMessage's reply curve, in the fork's color. */
export function ReplyCurve({ tone, className }: { tone: ForkTone; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "-mt-3 h-[18px] w-4 shrink-0 rounded-bl-[12px] border-b-2 border-l-2 opacity-70",
        FORK_TONE_CLASS[tone].border,
        className,
      )}
    />
  );
}

/** Nova is working in this fork: a pulsing dot, named for screen readers. */
export function LiveDot({ tone, className }: { tone?: ForkTone; className?: string }) {
  return (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "inline-block size-[7px] shrink-0 rounded-full animate-[rkPulse_1.6s_ease-in-out_infinite] motion-reduce:animate-none",
          tone ? FORK_TONE_CLASS[tone].bg : "bg-success",
          className,
        )}
      />
      <span className="sr-only">
        <Trans>Nova is working</Trans>
      </span>
    </>
  );
}

/** A fork's time: the clock today, else the day. */
export function forkTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const locale = i18n.locale || "en";
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString(locale, { month: "short", day: "numeric" });
}
