import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, ComputerReleaseReason, ComputerStatus } from "@nova/contracts";
import { Button } from "@nova/ui-web";
import { embeddableScreenUrl } from "../../../lib/computer-screen";
import { StatusPill } from "../ui";
import type { useComputerScreen } from "./useComputerScreen";

export function ComputerReleaseActions({
  takeoverRequested,
  onRelease,
  museName,
}: {
  takeoverRequested: boolean;
  onRelease: (reason?: ComputerReleaseReason) => Promise<void>;
  /** Muse mode: the primary "hand back" action names the Muse. */
  museName?: string;
}) {
  if (!takeoverRequested) {
    return museName ? (
      <Button type="button" size="sm" onClick={() => void onRelease()}>
        <Trans>Hand back to {museName}</Trans>
      </Button>
    ) : (
      <Button type="button" variant="outline" size="sm" onClick={() => void onRelease()}>
        <Trans>Release</Trans>
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" size="sm" onClick={() => void onRelease("skipped")}>
        <Trans>Skip</Trans>
      </Button>
      <Button type="button" size="sm" onClick={() => void onRelease("done")}>
        <Trans>I’m done</Trans>
      </Button>
    </div>
  );
}

export function DesktopKindEmptyState({ className }: { className?: string }) {
  return (
    <div className={className}>
      <Trans>
        This bot runs on this computer, not a Linux desktop. Shell and files use your home folder.
      </Trans>
    </div>
  );
}

export function computerPlaceholder(
  state: ComputerStatus["state"] | undefined,
  booting: boolean,
  label: string,
) {
  if (state === "booting" || booting) return t`Booting live desktop…`;
  if (state === "running") return label;
  if (state === "suspended") return t`Computer is asleep. Open it to wake.`;
  if (state === "error") return t`Computer failed to boot`;
  return t`Computer is stopped`;
}

export function computerLabel(mode: ComputerStatus["mode"] | undefined, botName: string) {
  return mode === "dedicated" ? t`${botName}’s computer` : t`Team Computer`;
}

/** Muse computer panel title: a plain heading and a status pill instead of the raw state. */
export function MuseComputerTitle({
  state,
  booting,
  screenFailed,
  runnerReady,
}: {
  state?: string;
  booting: boolean;
  /** The Conversation's runner is not connected yet (e.g. after a Computer restart). */
  runnerReady?: boolean;
  /** The screen link could not be loaded, so the computer is not actually viewable. */
  screenFailed: boolean;
}) {
  const { t } = useLingui();
  const starting = booting || state === "booting" || (state === "running" && runnerReady === false);
  const failed = state === "error";
  const unreachable = state === "running" && screenFailed;
  const running = state === "running" && !screenFailed && !starting;
  return (
    <span className="flex items-center gap-2.5">
      <span className="text-[15.5px] font-semibold text-foreground">
        <Trans>Computer</Trans>
      </span>
      <StatusPill
        tone={running ? "live" : starting || failed || unreachable ? "attention" : "neutral"}
      >
        {running
          ? t`Live`
          : starting
            ? t`Starting`
            : unreachable
              ? t`Can't connect`
              : failed
                ? t`Needs a restart`
                : t`Asleep`}
      </StatusPill>
    </span>
  );
}

/** The embeddable screen link and, when loading it failed, an alert with a retry. */
export function screenView(
  screen: ReturnType<typeof useComputerScreen>,
  computerBot: Bot | undefined,
) {
  const { screenUrl, computerError, computerErrorFromScreen, refreshComputerScreen } = screen;
  const embeddedScreenUrl = embeddableScreenUrl(screenUrl);
  const hideScreenLoadError = computerErrorFromScreen && Boolean(embeddedScreenUrl);
  const computerScreenError =
    computerError && !hideScreenLoadError ? (
      <div role="alert" className="flex flex-col items-center gap-3 px-6 text-center text-sm">
        <p className="text-destructive">{computerError}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => computerBot && void refreshComputerScreen(computerBot.id, { force: true })}
        >
          <Trans>Retry screen</Trans>
        </Button>
      </div>
    ) : null;
  return { embeddedScreenUrl, computerScreenError };
}
