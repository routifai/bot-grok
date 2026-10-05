import { useLingui } from "@lingui/react/macro";
import { type MutableRefObject, useEffect, useRef, useState } from "react";
import {
  loadComputerScreen,
  screenLinkKey,
  screenUrlStillFresh,
  shareInflight,
} from "../../../lib/computer-screen";
import { rpc } from "../../../lib/rpc";
import { SCREEN_DISCONNECTED_MESSAGE } from "../../../novnc-html";

import type { useComputerStore } from "./useComputerStore";

/** The live screen link of the computer panel: loading, retry with backoff, and remount when
 * the embedded desktop reports a dropped connection. */
export function useComputerScreen({
  computerStore,
  activeBotId,
}: {
  computerStore: ReturnType<typeof useComputerStore>;
  activeBotId: MutableRefObject<string | undefined>;
}) {
  const { t } = useLingui();
  const {
    computerRef,
    computerCacheRef,
    cacheComputerFor,
    computerBotIdRef,
    computerVisible,
    screenLinkKeys,
  } = computerStore;
  const [screenUrl, setScreenUrl] = useState<string | null>(null);
  const [computerError, setComputerError] = useState<string | null>(null);
  // Screen-load failures can sit beside a still-valid embed URL; boot and
  // takeover failures must stay visible even when a URL remains.
  const [computerErrorFromScreen, setComputerErrorFromScreen] = useState(false);
  // Consecutive failed screen loads; drives the automatic retry below.
  const [screenFailures, setScreenFailures] = useState(0);
  const screenRequest = useRef(0);
  /** Bots whose screen link must be re-fetched (after boot, takeover, or release). */
  const staleScreens = useRef(new Set<string>());
  const screenInflight = useRef(new Map<string, Promise<string | null>>());
  /** Bumped to remount the screen frames after a dropped connection. */
  const [screenReloadKey, setScreenReloadKey] = useState(0);
  const refreshScreenRef = useRef<(id: string, options?: { force?: boolean }) => Promise<unknown>>(
    async () => null,
  );

  // A dropped desktop connection (computer restarted, view session rotated) would otherwise
  // leave the frame black: when the embedded viewer reports a disconnect, fetch a fresh link
  // and remount the frame.
  useEffect(() => {
    let last = 0;
    const onMessage = (event: MessageEvent) => {
      if ((event.data as { type?: unknown } | null)?.type !== SCREEN_DISCONNECTED_MESSAGE) return;
      const frames = document.querySelectorAll<HTMLIFrameElement>("iframe[data-computer-screen]");
      if (![...frames].some((frame) => frame.contentWindow === event.source)) return;
      const now = Date.now();
      if (now - last < 5_000) return;
      last = now;
      const id = computerBotIdRef.current ?? activeBotId.current;
      if (!id) return;
      staleScreens.current.add(id);
      setScreenReloadKey((current) => current + 1);
      void refreshScreenRef.current(id, { force: true }).catch(() => undefined);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // A screen that failed to load (often because the computer was still booting) retries on its
  // own with backoff while the computer view is open, instead of waiting for Retry screen.
  useEffect(() => {
    if (screenFailures === 0 || screenFailures > 8) return;
    const timer = window.setTimeout(
      () => {
        if (!computerVisible.current) return;
        const id = computerBotIdRef.current ?? activeBotId.current;
        if (id) void refreshScreenRef.current(id, { force: true }).catch(() => undefined);
      },
      Math.min(15_000, 2_000 * 2 ** (screenFailures - 1)),
    );
    return () => window.clearTimeout(timer);
  }, [screenFailures]);

  async function refreshComputerScreen(id: string, options: { force?: boolean } = {}) {
    if (!computerVisible.current) return null;
    // Re-fetching mints a new capability link, which reloads the embedded desktop (a black
    // flash) and queues on the supervisor's per-computer screen lock. Keep a link that is
    // still valid unless something about the screen changed (boot, control, status).
    const held = computerCacheRef.current.get(id)?.screenUrl ?? null;
    if (!options.force && !staleScreens.current.has(id) && screenUrlStillFresh(held)) return held;
    return shareInflight(
      screenInflight.current,
      id,
      () => {
        const request = ++screenRequest.current;
        return loadComputerScreen({
          load: () => rpc.computer.screenUrl({ botId: id }),
          isCurrent: () =>
            request === screenRequest.current &&
            (activeBotId.current === id || computerBotIdRef.current === id) &&
            computerVisible.current,
          commit: (screen) => {
            if (!screen.error) staleScreens.current.delete(id);
            screenLinkKeys.current.set(id, screenLinkKey(computerRef.current));
            setScreenUrl(screen.url);
            setComputerError(screen.error);
            setComputerErrorFromScreen(Boolean(screen.error));
            setScreenFailures((count) => (screen.error ? count + 1 : 0));
            cacheComputerFor(id, { screenUrl: screen.url });
          },
          fallbackError: t`Could not connect to the computer screen`,
        });
      },
      Boolean(options.force),
    );
  }
  refreshScreenRef.current = refreshComputerScreen;
  return {
    screenUrl,
    setScreenUrl,
    computerError,
    setComputerError,
    computerErrorFromScreen,
    setComputerErrorFromScreen,
    screenRequest,
    staleScreens,
    screenReloadKey,
    refreshComputerScreen,
  };
}
