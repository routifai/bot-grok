import type { Bot } from "@superchat/contracts";
import type { ReactNode } from "react";
import { rpc } from "../../../lib/rpc";
import { BotSettings } from "../../shell/bot-panel";

/** The Muse's settings panel: save, export and clear. */
export function BotSettingsPanel({
  active,
  skillsSection,
  refreshBots,
  onClear,
}: {
  active: Bot;
  skillsSection?: ReactNode;
  refreshBots: () => Promise<void>;
  onClear?: () => void;
}) {
  return (
    <BotSettings
      key={active.id}
      bot={active}
      skillsSection={skillsSection}
      onSave={async ({ computerMode, ...patch }) => {
        if (computerMode !== active.computerMode) {
          await rpc.bots.setComputer({
            botId: active.id,
            mode: computerMode,
          });
        }
        await rpc.bots.update({ botId: active.id, ...patch });
        await refreshBots();
      }}
      onExport={async () => {
        const manifest = await rpc.export.bot({ botId: active.id });
        const blob = new Blob([JSON.stringify(manifest, null, 2)], {
          type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${active.name.toLowerCase().replace(/\s+/g, "-")}-export.json`;
        a.click();
        URL.revokeObjectURL(url);
      }}
      onClear={onClear}
    />
  );
}
