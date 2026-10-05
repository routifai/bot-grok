import type { Bot, ComputerMode } from "@aiden/contracts";
import { normalizeCreateBotProfile } from "@aiden/contracts";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useEffect,
  useRef,
} from "react";
import type { NavigateFunction } from "react-router-dom";
import { scheduleFocusPrompt } from "../../../lib/focus-prompt";
import { rpc } from "../../../lib/rpc";

import type { Panel } from "./panel";

/** Creating a bot, and the delayed focus prompt that follows onboarding. */
export function useCreateBot({
  botsRef,
  setBots,
  navigate,
  setPanel,
  refreshBots,
  activeBotId,
  activeId,
}: {
  botsRef: MutableRefObject<Bot[]>;
  setBots: Dispatch<SetStateAction<Bot[]>>;
  navigate: NavigateFunction;
  setPanel: Dispatch<SetStateAction<Panel>>;
  refreshBots: (includeArchived?: boolean) => Promise<void>;
  activeBotId: MutableRefObject<string | undefined>;
  activeId: string | undefined;
}) {
  const focusPromptAbortRef = useRef<AbortController | null>(null);
  const focusPromptBotIdRef = useRef<string | null>(null);

  function cancelFocusPrompt() {
    focusPromptAbortRef.current?.abort();
    focusPromptAbortRef.current = null;
    focusPromptBotIdRef.current = null;
  }

  async function createBot(input: {
    name: string;
    title: string;
    description: string;
    computerMode: ComputerMode;
  }) {
    const isFirstBot = botsRef.current.length === 0;
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
    // Register cancellation before awaiting start so leaving the bot during
    // startup cannot miss the abort and still schedule a late focus card.
    cancelFocusPrompt();
    const controller = new AbortController();
    focusPromptAbortRef.current = controller;
    focusPromptBotIdRef.current = bot.id;
    const started = await rpc.onboarding
      .start({ botId: bot.id })
      .then(() => true)
      .catch(() => false);
    if (!started || controller.signal.aborted || focusPromptBotIdRef.current !== bot.id) {
      if (focusPromptAbortRef.current === controller) {
        focusPromptAbortRef.current = null;
        focusPromptBotIdRef.current = null;
      }
      await refreshBots().catch(() => undefined);
      return;
    }
    void scheduleFocusPrompt({
      immediate: isFirstBot,
      signal: controller.signal,
      prompt: async () => {
        if (focusPromptBotIdRef.current !== bot.id || activeBotId.current !== bot.id) return;
        await rpc.onboarding.promptFocus({ botId: bot.id }).catch(() => undefined);
      },
    }).finally(() => {
      if (focusPromptAbortRef.current === controller) {
        focusPromptAbortRef.current = null;
        focusPromptBotIdRef.current = null;
      }
    });
    await refreshBots().catch(() => undefined);
  }

  useEffect(() => {
    if (focusPromptBotIdRef.current && focusPromptBotIdRef.current !== activeId) {
      cancelFocusPrompt();
    }
  }, [activeId]);

  useEffect(() => () => cancelFocusPrompt(), []);
  return { createBot, cancelFocusPrompt, focusPromptBotIdRef };
}
