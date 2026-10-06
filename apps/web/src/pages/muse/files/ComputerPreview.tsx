import type { Bot, ComputerStatus } from "@aiden/contracts";
import { Button, cn } from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { Maximize2 } from "lucide-react";
import type { ReactNode } from "react";
import {
  ComputersUnavailableHint,
  computersAreUnavailable,
} from "../../../components/ComputersUnavailableHint";
import { screenIframeSandbox } from "../../../lib/computer-screen";
import { museMode } from "../chrome/museMode";
import { FilesTab } from "../files/FilesTab";
import { FirstRunHint } from "../intro";
import {
  computerLabel,
  computerPlaceholder,
  DesktopKindEmptyState,
  screenView,
} from "./computerPanelParts";
import type { useComputer } from "./useComputer";
import type { useComputerScreen } from "./useComputerScreen";
import type { ComputerView } from "./useComputerView";

/** The side-panel computer: live preview, Files tab and whatever the panel adds below
 * (the routine list). */
export function ComputerPreview({
  active,
  computer,
  ctl,
  screen,
  computerView,
  filesRefreshKey,
  filesReveal,
  sandboxProvider,
  children,
}: {
  active: Bot;
  computer: ComputerStatus | null;
  ctl: ReturnType<typeof useComputer>;
  screen: ReturnType<typeof useComputerScreen>;
  computerView: ComputerView;
  filesRefreshKey: number;
  filesReveal: { path: string; nonce: number } | null;
  sandboxProvider: string | undefined;
  children: ReactNode;
}) {
  const { t } = useLingui();
  const { booting, computerOpen, computerBot, openComputer } = ctl;
  const { screenReloadKey } = screen;
  const { embeddedScreenUrl, computerScreenError } = screenView(screen, computerBot);
  return (
    <div>
      {museMode && computerView === "files" ? (
        <FilesTab botId={active.id} refreshKey={filesRefreshKey} reveal={filesReveal} />
      ) : null}
      <div className={museMode && computerView === "files" ? "hidden" : undefined}>
        <div
          data-testid="computer-preview"
          className={cn(
            "group relative aspect-[16/10] overflow-hidden rounded-[14px] bg-background",
            museMode && "rounded-xl border border-border bg-muted shadow-sm",
          )}
        >
          {computerOpen ? (
            <div className="grid h-full place-items-center text-sm text-muted-foreground/80">
              <Trans>Open in full window</Trans>
            </div>
          ) : computer?.kind === "desktop" ? (
            <DesktopKindEmptyState className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground/80" />
          ) : computer?.state === "running" && embeddedScreenUrl && !computerScreenError ? (
            <iframe
              key={`preview-${screenReloadKey}`}
              data-computer-screen=""
              title={t`Bot screen preview`}
              src={embeddedScreenUrl}
              sandbox={screenIframeSandbox(embeddedScreenUrl)}
              className="h-full w-full border-0 bg-black"
              allow="clipboard-read; clipboard-write"
              style={{ pointerEvents: "none" }}
            />
          ) : (
            <div className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground/80">
              {computerScreenError ??
                (computersAreUnavailable(sandboxProvider) ? (
                  <ComputersUnavailableHint />
                ) : (
                  computerPlaceholder(
                    computer?.state,
                    booting,
                    computerLabel(computer?.mode, active.name),
                  )
                ))}
            </div>
          )}
          {!computerScreenError ? (
            <button
              type="button"
              data-testid="computer-preview-open"
              className="absolute inset-0 flex cursor-pointer items-center justify-center bg-overlay/40 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              aria-label={t`Open`}
              onClick={() => void openComputer()}
            >
              <span className="inline-flex items-center gap-2 rounded-full bg-overlay px-3.5 py-2 text-[14px] text-foreground shadow-md">
                <Maximize2 size={15} strokeWidth={1.9} aria-hidden />
                <Trans>Open</Trans>
              </span>
            </button>
          ) : null}
        </div>
        {museMode ? (
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="truncate text-[14px] text-muted-foreground" dir="auto">
              {t`Watch ${active.name} work`}
            </p>
            {!computerScreenError ? (
              <Button size="sm" variant="outline" onClick={() => void openComputer()}>
                <Maximize2 size={14} strokeWidth={1.9} aria-hidden />
                <Trans>Open</Trans>
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="mt-2 truncate text-[13.5px] text-muted-foreground" dir="auto">
            {t`${active.name}'s screen`}
          </p>
        )}
        {museMode ? (
          // Under the preview, never over it.
          <FirstRunHint
            variant="inline"
            hintKey="computer-panel"
            className="mt-3"
            text={t`Take over anytime.`}
          />
        ) : null}
        {museMode ? <div className="mt-8 border-t border-border pt-2" aria-hidden="true" /> : null}
        {children}
      </div>
    </div>
  );
}
