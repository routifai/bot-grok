import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, ComputerStatus, TaughtSkill } from "@nova/contracts";
import { BotAvatar, Button } from "@nova/ui-web";
import { Monitor, X } from "lucide-react";
import { ComputerMaintenanceActions } from "../../../components/ComputerMaintenanceActions";
import { TeachCaptureOverlay } from "../../../components/teach/TeachCaptureOverlay";
import { TeachComputerOverlayControl } from "../../../components/teach/TeachComputerOverlay";
import {
  TeachRecordingChrome,
  TeachStopButton,
} from "../../../components/teach/TeachRecordingChrome";
import { screenIframeSandbox } from "../../../lib/computer-screen";
import { type activeThreadRuns, userHoldsComputerControl } from "../../../lib/thread-events";
import { museMode } from "../chrome/museMode";
import { NovaTile } from "../chrome/NovaTile";
import { StatusPill } from "../ui";
import {
  ComputerReleaseActions,
  computerLabel,
  DesktopKindEmptyState,
  screenView,
} from "./computerPanelParts";
import type { useComputer } from "./useComputer";
import type { useComputerScreen } from "./useComputerScreen";

// Mirrors ENGINE_COMPUTER_ID (core/node): teaching on the engine records it as the control lease.
const ENGINE_TEACH_LEASE = "engine";

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
  teach: {
    recordingSkill: TaughtSkill | null;
    teachBusy: boolean;
    stopTeaching: () => Promise<void>;
    refreshActiveTeaching: () => Promise<void>;
  };
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
  const { recordingSkill, teachBusy, stopTeaching, refreshActiveTeaching } = teach;
  const { composerRunning, sending, sendError, stopRun } = run;
  const { embeddedScreenUrl, computerScreenError } = screenView(screen, computerBot);
  const hasControl = userHoldsComputerControl(computer, computerBot?.id);
  // On the engine the person demonstrates straight into the interactive stream (the engine holds
  // control); Nova's capture overlay would sit on top of it and swallow every click and key.
  const teachesOnEngine = recordingSkill?.recording.controlLeaseId === ENGINE_TEACH_LEASE;
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
                {museMode ? (
                  <NovaTile tone="gray" size={28}>
                    <Monitor strokeWidth={2.2} />
                  </NovaTile>
                ) : (
                  <BotAvatar
                    color={computerBot.color}
                    identity={computerBot.id}
                    size={28}
                    status={computerBot.status}
                  />
                )}
                {recordingSkill ? (
                  <TeachRecordingChrome
                    recording={recordingSkill}
                    busy={teachBusy}
                    onStop={stopTeaching}
                    variant="overlay"
                  />
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
                {museMode && !recordingSkill && hasControl ? (
                  <StatusPill tone={computer?.takeoverRequested ? "attention" : "live"}>
                    {computer?.takeoverRequested ? t`Needs you` : t`You have control`}
                  </StatusPill>
                ) : !recordingSkill && hasControl ? (
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
                {recordingSkill ? (
                  <TeachStopButton busy={teachBusy} onStop={stopTeaching} />
                ) : hasControl ? (
                  <ComputerReleaseActions
                    takeoverRequested={Boolean(computer?.takeoverRequested)}
                    onRelease={releaseComputer}
                    museName={museMode ? computerBot.name : undefined}
                  />
                ) : null}
                {computerBot && !recordingSkill ? (
                  <TeachComputerOverlayControl
                    key={computerBot.id}
                    botId={computerBot.id}
                    computer={computer}
                    busy={teachBusy}
                    onRefresh={refreshActiveTeaching}
                  />
                ) : null}
                {computerBot && !recordingSkill ? (
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
                      pointerEvents:
                        (recordingSkill && !teachesOnEngine) || !hasControl ? "none" : "auto",
                    }}
                  />
                  {computerBot && !teachesOnEngine ? (
                    <TeachCaptureOverlay
                      botId={computerBot.id}
                      skill={recordingSkill}
                      enabled={Boolean(recordingSkill)}
                      screenWidth={computer?.screenWidth}
                      screenHeight={computer?.screenHeight}
                    />
                  ) : null}
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
