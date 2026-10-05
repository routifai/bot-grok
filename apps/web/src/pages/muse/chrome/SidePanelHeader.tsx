import type { Bot, ComputerStatus, ThreadSnapshot } from "@aiden/contracts";
import { Button } from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { Settings, X } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { ComputerMaintenanceActions } from "../../../components/ComputerMaintenanceActions";
import { computerPanelNeedsMaintenance } from "../../../lib/thread-events";
import { ComputerViewSwitch } from "../files/ComputerViewSwitch";
import { MuseComputerTitle } from "../files/computerPanelParts";
import type { useComputer } from "../files/useComputer";
import type { useComputerScreen } from "../files/useComputerScreen";
import type { ComputerView } from "../files/useComputerView";
import { museMode } from "./museMode";
import type { Panel } from "./panel";

/** The side panel's title row: what is open, the computer view switch and the close button. */
export function SidePanelHeader({
  panel,
  setPanel,
  active,
  computer,
  ctl,
  screen,
  computerView,
  setComputerView,
  refreshThread,
}: {
  panel: Panel;
  setPanel: Dispatch<SetStateAction<Panel>>;
  active: Bot | undefined;
  computer: ComputerStatus | null;
  ctl: ReturnType<typeof useComputer>;
  screen: ReturnType<typeof useComputerScreen>;
  computerView: ComputerView;
  setComputerView: (view: ComputerView) => void;
  refreshThread: (id: string) => Promise<ThreadSnapshot>;
}) {
  const { t } = useLingui();
  const { booting, computerOpen } = ctl;
  const { computerError, screenUrl } = screen;
  return (
    <div className="mb-4 flex items-center justify-between">
      {museMode && panel === "computer" && active ? (
        <MuseComputerTitle
          state={computer?.state}
          booting={booting}
          runnerReady={computer?.runnerReady}
          screenFailed={Boolean(computerError) && !screenUrl}
        />
      ) : (
        <span className="text-[13.5px] text-muted-foreground">
          {panel === "settings" ? (
            <Trans>Settings</Trans>
          ) : active ? (
            (computer?.state ?? active.status)
          ) : (
            <Trans>Group</Trans>
          )}
        </span>
      )}
      <div className="flex items-center gap-1">
        {museMode && active && panel === "computer" ? (
          <ComputerViewSwitch value={computerView} onChange={setComputerView} />
        ) : null}
        {active &&
        panel === "computer" &&
        !computerOpen &&
        computerPanelNeedsMaintenance(computer?.state, booting) ? (
          <ComputerMaintenanceActions
            botId={active.id}
            computer={computer}
            onChanged={async () => {
              await refreshThread(active.id);
            }}
          />
        ) : null}
        {active ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={panel === "settings" ? t`Show computer` : t`Show settings`}
            onClick={() => setPanel(panel === "settings" ? "computer" : "settings")}
            className={panel === "settings" ? "text-foreground" : "text-muted-foreground"}
          >
            <Settings size={16} strokeWidth={1.7} />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Close panel`}
          onClick={() => setPanel(null)}
        >
          <X size={16} strokeWidth={1.8} />
        </Button>
      </div>
    </div>
  );
}
