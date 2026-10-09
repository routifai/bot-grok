import { useLingui } from "@lingui/react/macro";
import type { Bot, ComputerReleaseReason, ThreadSnapshot } from "@nova/contracts";
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import {
  computerPanelAutoBoot,
  computerPanelAutoUsesBoot,
  computerTakeoverBlocked,
  userHoldsComputerControl,
} from "../../lib/thread-events";
import type { Panel } from "../../pages/muse/chrome/panel";
import type { useComputerScreen } from "./useComputerScreen";
import type { useComputerStore } from "./useComputerStore";

/** Opening, booting and releasing the Muse's computer: the side-panel preview and the
 * full-window view. */
export function useComputer({
  target,
  panel,
  computerStore,
  screen,
  thread,
}: {
  target: {
    active: Bot | undefined;
    bots: Bot[];
    botsRef: MutableRefObject<Bot[]>;
    activeBotId: MutableRefObject<string | undefined>;
    activeGroupId: MutableRefObject<string | undefined>;
  };
  panel: Panel;
  computerStore: ReturnType<typeof useComputerStore>;
  screen: ReturnType<typeof useComputerScreen>;
  thread: {
    snapshot: ThreadSnapshot | null;
    refreshThread: (id: string, signal?: AbortSignal) => Promise<ThreadSnapshot>;
    refreshThreadRef: MutableRefObject<
      (id: string, signal?: AbortSignal) => Promise<ThreadSnapshot>
    >;
    refreshGroupThreadRef: MutableRefObject<
      (id: string, signal?: AbortSignal) => Promise<ThreadSnapshot>
    >;
  };
}) {
  const { t } = useLingui();
  const { active, bots, botsRef, activeBotId, activeGroupId } = target;
  const { snapshot, refreshThread, refreshThreadRef, refreshGroupThreadRef } = thread;
  const {
    computer,
    computerCacheRef,
    cacheComputerFor,
    commitComputer,
    computerOpenRef,
    computerBotIdRef,
    computerVisible,
  } = computerStore;
  const {
    screenUrl,
    setScreenUrl,
    setComputerError,
    setComputerErrorFromScreen,
    staleScreens,
    refreshComputerScreen,
  } = screen;
  const [booting, setBooting] = useState(false);
  const [computerOpen, setComputerOpen] = useState(false);
  const [computerBotId, setComputerBotId] = useState<string | undefined>();
  const computerBootEpoch = useRef(0);
  const openComputerRef = useRef<(botId?: string) => Promise<void>>(async () => {});
  const [computerViewport, setComputerViewport] = useState<{
    height: number;
    offsetTop: number;
  } | null>(null);
  useEffect(() => {
    if (!computerOpen) {
      setComputerViewport(null);
      return;
    }
    const viewport = window.visualViewport;
    if (!viewport) return;
    const sync = () => {
      setComputerViewport({ height: viewport.height, offsetTop: viewport.offsetTop });
    };
    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
    };
  }, [computerOpen]);
  const autoBooted = useRef<string | null>(null);
  computerVisible.current = panel === "computer" || computerOpen;
  const computerBot =
    (computerBotId ? bots.find((bot) => bot.id === computerBotId) : undefined) ?? active;
  computerOpenRef.current = computerOpen;
  computerBotIdRef.current = computerBotId ?? active?.id;
  // Closing the full window remounts the panel preview on a link the full view already used,
  // which connects to nothing and stays black; give the preview a fresh link.
  const wasComputerOpen = useRef(false);
  useEffect(() => {
    const closed = wasComputerOpen.current && !computerOpen;
    wasComputerOpen.current = computerOpen;
    const id = computerBotIdRef.current;
    if (!closed || !id) return;
    staleScreens.current.add(id);
    void refreshComputerScreen(id, { force: true }).catch(() => undefined);
  }, [computerOpen]);

  async function bootComputer({
    botId: targetBotId,
    takeControl,
    overlay,
    force = false,
  }: {
    botId: string;
    takeControl: boolean;
    overlay: boolean;
    force?: boolean;
  }) {
    const epoch = ++computerBootEpoch.current;
    const stillThisBoot = () => computerBootEpoch.current === epoch;
    const stillThisBot = () =>
      computerBotIdRef.current === targetBotId || activeBotId.current === targetBotId;
    const cached = computerCacheRef.current.get(targetBotId);
    const targetComputer = computer?.botId === targetBotId ? computer : (cached?.computer ?? null);
    const targetScreen = computer?.botId === targetBotId ? screenUrl : (cached?.screenUrl ?? null);
    const needsBoot = force || targetComputer?.state !== "running" || !targetScreen;
    if (overlay && needsBoot) setBooting(true);
    setComputerError(null);
    setComputerErrorFromScreen(false);
    try {
      if (needsBoot) {
        const status = await rpc.computer.boot({ botId: targetBotId });
        if (!stillThisBoot() || !stillThisBot()) return;
        commitComputer(status);
        cacheComputerFor(targetBotId, { computer: status });
      }
      if (takeControl) {
        await rpc.computer.takeover({ botId: targetBotId });
        if (!stillThisBoot() || !stillThisBot()) return;
      }
      if (needsBoot || takeControl) staleScreens.current.add(targetBotId);
      await refreshComputerFor(targetBotId);
    } catch (error) {
      if (!stillThisBoot() || !stillThisBot()) return;
      setComputerError(error instanceof Error ? error.message : t`Could not take control`);
      setComputerErrorFromScreen(false);
      throw error;
    } finally {
      if (stillThisBoot()) setBooting(false);
    }
  }

  async function refreshComputerFor(targetBotId: string) {
    if (activeBotId.current === targetBotId) {
      await refreshThread(targetBotId);
      return;
    }
    if (computerBotIdRef.current !== targetBotId) return;
    const status = await rpc.computer.status({ botId: targetBotId });
    if (computerBotIdRef.current !== targetBotId) return;
    commitComputer(status);
    cacheComputerFor(targetBotId, { computer: status });
    await refreshComputerScreen(targetBotId);
  }

  useEffect(() => {
    if (panel !== "computer") {
      autoBooted.current = null;
      return;
    }
    if (!active) return;
    const botId = active.id;
    let cancelled = false;
    void (async () => {
      // Refresh from the server first. A stale SSE "booting" snapshot used to
      // skip this effect, so an RPC takeover never showed "You have control".
      const snap = await refreshThread(botId).catch(() => null);
      if (cancelled || activeBotId.current !== botId) return;
      const state = snap?.computer?.state;
      const screen = state === "running" ? await refreshComputerScreen(botId) : null;
      if (cancelled || activeBotId.current !== botId) return;
      const action = computerPanelAutoBoot(state, screen);
      if (action === "wait") {
        if (state === "running") autoBooted.current = botId;
        return;
      }
      if (action === "boot" && autoBooted.current === botId) return;
      autoBooted.current = botId;
      if (!computerPanelAutoUsesBoot(action)) return;
      await bootComputer({
        botId,
        takeControl: false,
        overlay: action === "boot",
        force: true,
      }).catch(() => undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, [panel, active?.id]);

  useEffect(() => {
    setComputerOpen(false);
    setComputerError(null);
    setComputerErrorFromScreen(false);
    setComputerBotId(active?.id);
  }, [active?.id]);

  useEffect(() => {
    if (!computer?.busyBotName) {
      setComputerError(null);
      setComputerErrorFromScreen(false);
    }
  }, [computer?.busyBotName]);

  useEffect(() => {
    if (!computerOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setComputerOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [computerOpen]);

  useEffect(() => {
    const heartbeatBotId = computerBot?.id ?? active?.id;
    if ((panel !== "computer" && !computerOpen) || !heartbeatBotId || computer?.state !== "running")
      return;
    const ping = () =>
      void rpc.computer.heartbeat({ botId: heartbeatBotId }).catch(() => undefined);
    ping();
    const timer = window.setInterval(ping, 60_000);
    return () => window.clearInterval(timer);
  }, [panel, computerOpen, computerBot?.id, active?.id, computer?.state]);

  async function openComputer(botId?: string) {
    const id = botId ?? active?.id;
    if (!id) return;
    const bot = botsRef.current.find((candidate) => candidate.id === id);
    if (!bot) return;
    computerBotIdRef.current = id;
    setComputerBotId(id);
    const cached = computerCacheRef.current.get(id);
    const targetComputer = computer?.botId === id ? computer : (cached?.computer ?? null);
    const targetScreen = computer?.botId === id ? screenUrl : (cached?.screenUrl ?? null);
    if (computer?.botId !== id) {
      commitComputer(targetComputer);
      setScreenUrl(targetScreen);
    }
    setComputerOpen(true);
    computerVisible.current = true;
    const needsTakeover = !userHoldsComputerControl(targetComputer, id);
    const blocked = computerTakeoverBlocked(targetComputer, snapshot?.run?.status);
    try {
      await bootComputer({
        botId: id,
        takeControl: needsTakeover && !blocked,
        overlay: (needsTakeover && !blocked) || targetComputer?.state !== "running",
        force: targetComputer?.state !== "running",
      });
    } catch {
      // computerError already set in bootComputer
    }
  }
  openComputerRef.current = openComputer;
  const onOpenComputer = useCallback((botId?: string) => {
    void openComputerRef.current(botId);
  }, []);

  const releaseComputer = useCallback(
    async (reason?: ComputerReleaseReason) => {
      const botId = computerBotIdRef.current ?? activeBotId.current;
      if (!botId) return;
      try {
        await rpc.computer.release({ botId, reason });
        // Control ended: the held control link is no longer the right one.
        staleScreens.current.add(botId);
        if (computerBotIdRef.current !== botId && activeBotId.current !== botId) return;
        setComputerOpen(false);
        const groupId = activeGroupId.current;
        if (groupId) {
          await refreshGroupThreadRef.current(groupId).catch(() => undefined);
        } else {
          await refreshThreadRef.current(botId).catch(() => undefined);
        }
      } catch {
        if (computerBotIdRef.current !== botId && activeBotId.current !== botId) return;
        setComputerError(t`Could not continue`);
        setComputerErrorFromScreen(false);
      }
    },
    [t],
  );
  return {
    booting,
    computerOpen,
    setComputerOpen,
    computerBot,
    computerViewport,
    openComputer,
    onOpenComputer,
    releaseComputer,
    refreshComputerFor,
  };
}
