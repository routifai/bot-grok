import type { Bot, ComputerMode } from "@superchat/contracts";
import { normalizeCreateBotProfile } from "@superchat/contracts";
import type { Dispatch, SetStateAction } from "react";
import type { NavigateFunction } from "react-router-dom";
import { rpc } from "../../../lib/rpc";

import type { Panel } from "./panel";

/** Creating a bot. */
export function useCreateBot({
  setBots,
  navigate,
  setPanel,
  refreshBots,
}: {
  setBots: Dispatch<SetStateAction<Bot[]>>;
  navigate: NavigateFunction;
  setPanel: Dispatch<SetStateAction<Panel>>;
  refreshBots: (includeArchived?: boolean) => Promise<void>;
}) {
  async function createBot(input: {
    name: string;
    title: string;
    description: string;
    computerMode: ComputerMode;
  }) {
    const bot = await rpc.bots.create({
      ...normalizeCreateBotProfile(input),
      notifyOnFinish: true,
      computerMode: input.computerMode,
    });
    setBots((current) =>
      current.some((item) => item.id === bot.id) ? current : [bot, ...current],
    );
    navigate(`/app/${bot.id}`);
    setPanel(null);
    await refreshBots().catch(() => undefined);
  }

  return { createBot };
}
