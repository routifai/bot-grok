import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, ComputerStatus } from "@nova/contracts";
import { Button } from "@nova/ui-web";
import { Monitor, X } from "lucide-react";
import type { ReactNode } from "react";
import { type activeThreadRuns, userHoldsComputerControl } from "../../lib/thread-events";
import { museMode } from "../../pages/muse/chrome/museMode";
import { NovaTile } from "../../pages/muse/chrome/NovaTile";
import { StatusPill } from "../../pages/muse/ui/index";
import { ComputerMaintenanceActions } from "./ComputerMaintenanceActions";
import { screenIframeSandbox } from "./computer-screen";
import {
  ComputerReleaseActions,
  computerLabel,
  DesktopKindEmptyState,
  screenView,
} from "./computerPanelParts";
import type { useComputer } from "./useComputer";
import type { useComputerScreen } from "./useComputerScreen";

/** What the skills capability puts on the Computer while the person teaches a task: the shell
 * passes it in, so the Computer knows nothing about teaching. */
export interface ComputerTeachSlots {
  /** A skill is being recorded: the title bar shows the recording, not the Computer's name. */
  recording: boolean;
  /** Nova's own overlay captures the demonstration, so the screen itself takes no input. */
  capturesInput: boolean;
  recordingChrome: ReactNode;
  stopButton: ReactNode;
  startControl: (botId: string) => ReactNode;
  captureOverlay: (botId: string) => ReactNode;
}

/** CSS zoom applied to #root (Muse wide-screen scaling); 1 when none. */
function rootZoom(): number {
  if (typeof document === "undefined") return 1;
  const root = document.getElementById("root");
  const zoom = root ? Number.parseFloat(getComputedStyle(root).zoom) : 1;
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

/** The boot splash and the full-window computer view with its control chrome. */
export function ComputerOverlay({
  active,
  computer,
  ctl,
  screen,
  teach,
  run,
}: {
  active: Bot | undefined;
  computer: ComputerStatus | null;
  ctl: ReturnType<typeof useComputer>;
  screen: ReturnType<typeof useComputerScreen>;
  teach: ComputerTeachSlots;
  run: {
    currentRuns: ReturnType<typeof activeThreadRuns>;
    composerRunning: boolean;
    sending: boolean;
    sendError: string | null;
    stopRun: () => Promise<void>;
  };
}) {
  const { t } = useLingui();
  const {
    booting,
    computerOpen,
    setComputerOpen,
    computerBot,
    computerViewport,
    releaseComputer,
    refreshComputerFor,
  } = ctl;
  const { screenReloadKey } = screen;
  const { recording } = teach;
  const { composerRunning, sending, sendError, stopRun } = run;
  const { embeddedScreenUrl, computerScreenError } = screenView(screen, computerBot);
  const hasControl = userHoldsComputerControl(computer, computerBot?.id);
  return (
    <>
      {booting ? (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-[22px] bg-background/95">
          <div className="text-[19px] font-medium text-foreground">
            <Trans>Booting up {computerBot?.name ?? active?.name}’s computer</Trans>
          </div>
          <div className="h-[5px] w-[min(420px,70%)] overflow-hidden rounded-full bg-accent">
            <div className="h-full w-2/3 rounded-full bg-primary" />
          </div>
        </div>
      ) : computerOpen && computerBot ? (
        <div className="fixed inset-0 z-30 bg-background">
          <div
            data-testid="computer-viewport"
            className="fixed inset-x-0 top-0 flex flex-col bg-background"
            style={(() => {
              // Window pixels grow with the Muse wide-screen zoom; divide so the view
              // fits the window instead of overflowing it (cropped, off-center desktop).
              const zoom = rootZoom();
              return {
                height: computerViewport
                  ? `${computerViewport.height / zoom}px`
                  : `calc(100dvh / ${zoom})`,
                top: computerViewport ? `${computerViewport.offsetTop / zoom}px` : undefined,
              };
            })()}
          >
            <div
              data-testid="computer-chrome"
              className={
                museMode
                  ? "flex h-16 items-center justify-between gap-4 border-b border-border bg-background px-5"
                  : "flex items-center justify-between gap-4 border-b border-sidebar-border px-[18px] py-3.5"
              }
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <NovaTile tone="gray" size={28}>
                  <Monitor strokeWidth={2.2} />
                </NovaTile>
                {recording ? (
                  teach.recordingChrome
                ) : (
                  <span
                    className={
                      museMode
                        ? "truncate text-[16px] font-semibold text-foreground"
                        : "truncate text-[15.5px] font-medium text-foreground"
                    }
                    dir="auto"
                  >
                    {museMode
                      ? t`${computerBot.name}'s computer`
                      : computerLabel(computer?.mode, computerBot.name)}
                  </span>
                )}
                {museMode && !recording && hasControl ? (
                  <StatusPill tone={computer?.takeoverRequested ? "attention" : "live"}>
                    {computer?.takeoverRequested ? t`Needs you` : t`You have control`}
                  </StatusPill>
                ) : !recording && hasControl ? (
                  computer?.takeoverRequested ? (
                    <span className="rounded-full bg-warning/15 px-[11px] py-1 text-[13px] text-warning">
                      <Trans>Needs you</Trans>
                    </span>
                  ) : (
                    <span className="rounded-full bg-success/15 px-[11px] py-1 text-[13px] text-success">
                      <Trans>You have control</Trans>
                    </span>
                  )
                ) : null}
              </div>
              <div
                className={
                  museMode
                    ? "flex items-center gap-2 [&_[data-slot=button]]:h-9 [&_[data-slot=button]]:rounded-full [&_[data-slot=button]]:text-[14px] [&_[data-slot=button]:not([aria-label])]:px-4"
                    : "flex items-center gap-3"
                }
              >
                {composerRunning ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t`Stop`}
                    data-testid="computer-overlay-stop"
                    onClick={() => void stopRun()}
                    disabled={sending}
                  >
                    <Trans>Stop</Trans>
                  </Button>
                ) : null}
                {recording ? (
                  teach.stopButton
                ) : hasControl ? (
                  <ComputerReleaseActions
                    takeoverRequested={Boolean(computer?.takeoverRequested)}
                    onRelease={releaseComputer}
                    museName={museMode ? computerBot.name : undefined}
                  />
                ) : null}
                {computerBot && !recording ? teach.startControl(computerBot.id) : null}
                {computerBot && !recording ? (
                  <ComputerMaintenanceActions
                    botId={computerBot.id}
                    computer={computer}
                    onChanged={async () => {
                      await refreshComputerFor(computerBot.id);
                    }}
                  />
                ) : null}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  aria-label={t`Close computer`}
                  onClick={() => (hasControl ? void releaseComputer() : setComputerOpen(false))}
                >
                  <X size={16} strokeWidth={1.8} />
                </Button>
              </div>
            </div>
            {sendError ? (
              <div
                role="alert"
                className="border-b border-destructive/40 bg-destructive/10 px-[18px] py-2 text-[13px] text-destructive"
              >
                {sendError}
              </div>
            ) : null}
            <div className="relative min-h-0 flex-1 bg-background">
              {computer?.kind === "desktop" ? (
                <DesktopKindEmptyState className="grid h-full place-items-center px-8 text-center text-sm text-muted-foreground/80" />
              ) : computer?.state === "running" && embeddedScreenUrl && !computerScreenError ? (
                <>
                  <iframe
                    key={`full-${screenReloadKey}`}
                    data-computer-screen=""
                    title={t`Bot screen`}
                    src={embeddedScreenUrl}
                    sandbox={screenIframeSandbox(embeddedScreenUrl)}
                    className="h-full w-full border-0 bg-black"
                    allow="clipboard-read; clipboard-write; fullscreen"
                    style={{
                      pointerEvents: teach.capturesInput || !hasControl ? "none" : "auto",
                    }}
                  />
                  {computerBot ? teach.captureOverlay(computerBot.id) : null}
                </>
              ) : (
                <div className="grid h-full place-items-center text-sm text-muted-foreground/80">
                  {computerScreenError ??
                    (computer?.state === "suspended"
                      ? t`Computer is asleep`
                      : computerLabel(computer?.mode, computerBot.name))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
