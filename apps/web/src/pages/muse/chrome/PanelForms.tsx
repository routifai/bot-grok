import type { AgentSkillCatalogEntry, Bot, Group, ThreadSnapshot } from "@aiden/contracts";
import type { Dispatch, SetStateAction } from "react";
import { useNavigate } from "react-router-dom";
import { rpc } from "../../../lib/rpc";
import { GroupSettings } from "../../GroupPanel";
import { BotSettings } from "../../shell/bot-panel";
import { firstThreadRoute } from "../conversation/threadEvents";
import type { Panel } from "./panel";

/** Group settings: save and remove. */
export function GroupSettingsPanel({
  activeGroup,
  bots,
  groups,
  setGroups,
  setPanel,
  refreshBots,
  refreshGroupThread,
}: {
  activeGroup: Group;
  bots: Bot[];
  groups: Group[];
  setGroups: Dispatch<SetStateAction<Group[]>>;
  setPanel: Dispatch<SetStateAction<Panel>>;
  refreshBots: () => Promise<void>;
  refreshGroupThread: (id: string) => Promise<ThreadSnapshot>;
}) {
  const navigate = useNavigate();
  return (
    <GroupSettings
      key={activeGroup.id}
      group={activeGroup}
      bots={bots}
      onSave={async (input) => {
        const updated = await rpc.groups.update({ groupId: activeGroup.id, ...input });
        setGroups((current) => current.map((group) => (group.id === updated.id ? updated : group)));
        setPanel(null);
        await Promise.all([refreshBots(), refreshGroupThread(activeGroup.id)]).catch(
          () => undefined,
        );
      }}
      onRemove={async () => {
        await rpc.groups.remove({ groupId: activeGroup.id });
        const remainingGroups = groups.filter((group) => group.id !== activeGroup.id);
        setGroups(remainingGroups);
        setPanel(null);
        navigate(firstThreadRoute(bots, remainingGroups), { replace: true });
        await refreshBots().catch(() => undefined);
      }}
    />
  );
}

/** The Muse's settings panel: save, export and clear. */
export function BotSettingsPanel({
  active,
  setAgentSkills,
  refreshBots,
  onClear,
}: {
  active: Bot;
  setAgentSkills: Dispatch<SetStateAction<AgentSkillCatalogEntry[]>>;
  refreshBots: () => Promise<void>;
  onClear: () => void;
}) {
  return (
    <BotSettings
      key={active.id}
      bot={active}
      onSkillsChange={setAgentSkills}
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
