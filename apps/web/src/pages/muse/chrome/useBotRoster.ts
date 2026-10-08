import type { Bot, Group, Me, Routine, ThreadSnapshot } from "@nova/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { NavigateFunction } from "react-router-dom";
import { takeInitialBootstrap } from "../../../lib/bootstrap";
import { localTimezone } from "../../../lib/local-timezone";
import { markOnce } from "../../../lib/performance";
import { rpc } from "../../../lib/rpc";
import { firstThreadRoute } from "../conversation/threadEvents";

/** The person's bots and groups: bootstrap, background refresh, unread flags. */
export function useBotRoster({
  botId,
  groupId,
  navigate,
  onBootstrapThread,
}: {
  botId: string | undefined;
  groupId: string | undefined;
  navigate: NavigateFunction;
  /** The bootstrap payload carries the first bot's thread and routines. */
  onBootstrapThread: (thread: ThreadSnapshot, routines: Routine[]) => void;
}) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const botsRef = useRef(bots);
  botsRef.current = bots;
  const botsRefreshEpoch = useRef(0);
  const botsRefreshApplied = useRef(0);
  const archivedBotsRefreshEpoch = useRef(0);
  const botsRefreshInFlight = useRef(0);
  const [initialBotsLoaded, setInitialBotsLoaded] = useState(false);
  const [bootstrapMe, setBootstrapMe] = useState<Me | null>();
  // Quiet hours and the daily topic digest run in the person's zone; keep it in step with
  // this browser (and a trip or DST-free move) without asking.
  const savedTimezone = bootstrapMe?.timezone;
  useEffect(() => {
    if (!savedTimezone) return;
    const timezone = localTimezone();
    if (timezone !== savedTimezone) {
      void rpc.preferences.update({ timezone }).catch(() => undefined);
    }
  }, [savedTimezone]);
  const manuallyUnread = useRef(new Set<string>());
  const routeBotId = useRef<string | undefined>(botId);
  routeBotId.current = botId;
  const routeGroupId = useRef<string | undefined>(groupId);
  routeGroupId.current = groupId;
  const updateBotUnread = useCallback((id: string, unread: boolean) => {
    setBots((current) => {
      const bot = current.find((candidate) => candidate.id === id);
      if (!bot || bot.unread === unread) return current;
      return current.map((candidate) =>
        candidate.id === id ? { ...candidate, unread } : candidate,
      );
    });
  }, []);
  const markBotRead = useCallback(
    async (id: string) => {
      await rpc.threads.markRead({ botId: id });
      manuallyUnread.current.delete(id);
      updateBotUnread(id, false);
    },
    [updateBotUnread],
  );
  // A bot the user marked unread by hand stays unread until they open it again,
  // otherwise the auto-read below would undo the action on the next window focus.
  const markBotReadIfVisible = useCallback(
    (id: string) => {
      if (manuallyUnread.current.has(id)) return;
      if (document.visibilityState === "visible" && document.hasFocus()) {
        void markBotRead(id).catch(() => undefined);
      }
    },
    [markBotRead],
  );

  const refreshBots = useCallback(
    async (includeArchived = false) => {
      markOnce("rk:renderer:bots-request-start");
      const request = ++botsRefreshEpoch.current;
      const archivedRequest = includeArchived ? ++archivedBotsRefreshEpoch.current : null;
      botsRefreshInFlight.current += 1;
      try {
        const [navigation, archived, archivedGroupList] = await Promise.all([
          rpc.spaces.list(),
          includeArchived ? rpc.bots.listArchived() : Promise.resolve(null),
          includeArchived ? rpc.groups.listArchived() : Promise.resolve(null),
        ]);
        const { bots: list, groups: groupList } = navigation.current;
        markOnce("rk:renderer:bots-response");
        const botsFresh = request === botsRefreshEpoch.current;
        const archivedFresh =
          archivedRequest != null && archivedRequest === archivedBotsRefreshEpoch.current;
        // A newer non-archived refresh can win the bots epoch while an older
        // includeArchived request still owns archivedBotsRefreshEpoch — apply
        // whichever slices are still current.
        if (!botsFresh && !archivedFresh) return;
        if (!botsFresh) return;
        setBots(list);
        setGroups(groupList);
        setInitialBotsLoaded(true);
        botsRefreshApplied.current = request;
        if (
          includeArchived &&
          list.length === 0 &&
          archived?.length === 0 &&
          groupList.length === 0 &&
          archivedGroupList?.length === 0 &&
          !navigation.spaces.some((space) => space.hasContent)
        ) {
          // Only the very first bot everywhere needs onboarding. An empty
          // current space with content elsewhere stays in the app so the
          // space can be switched to or deleted instead of trapping the user.
          navigate("/onboarding", { replace: true });
          return;
        }
        const currentGroupId = routeGroupId.current;
        if (currentGroupId) {
          if (!groupList.some((group) => group.id === currentGroupId)) {
            navigate(firstThreadRoute(list, groupList), { replace: true });
          }
          return;
        }
        const currentBotId = routeBotId.current;
        if (!currentBotId || !list.some((bot) => bot.id === currentBotId)) {
          navigate(firstThreadRoute(list, groupList), { replace: true });
        }
      } finally {
        botsRefreshInFlight.current -= 1;
      }
    },
    [navigate],
  );

  useEffect(() => {
    let cancelled = false;
    const appliedAtStart = botsRefreshApplied.current;
    void takeInitialBootstrap(botId)
      .then((bootstrap) => {
        if (cancelled) return;
        const groupList = bootstrap.groups;
        setBootstrapMe(bootstrap.me);
        // Skip list/route writes only if a later refreshBots() successfully
        // committed (failed refreshes bump epoch but not botsRefreshApplied).
        const applyBotLists = appliedAtStart === botsRefreshApplied.current;
        if (applyBotLists) {
          setBots(bootstrap.bots);
          setGroups(groupList);
          setInitialBotsLoaded(true);
        }
        if (!groupId && bootstrap.thread) {
          onBootstrapThread(bootstrap.thread, bootstrap.routines);
          markOnce("rk:renderer:thread-response");
        }
        if (!applyBotLists) return;
        if (
          bootstrap.bots.length === 0 &&
          bootstrap.archivedBots.length === 0 &&
          groupList.length === 0 &&
          bootstrap.archivedGroups.length === 0 &&
          !bootstrap.spaces.some((space) => space.hasContent)
        ) {
          navigate("/onboarding", { replace: true });
          return;
        }
        if (groupId) {
          if (!groupList.some((group) => group.id === groupId)) {
            navigate(firstThreadRoute(bootstrap.bots, groupList), { replace: true });
          }
          return;
        }
        const selectedBotId = bootstrap.thread?.botId ?? bootstrap.bots[0]?.id;
        if (selectedBotId && selectedBotId !== botId) {
          navigate(`/app/${selectedBotId}`, { replace: true });
        }
      })
      .catch(() => {
        if (cancelled) return;
        setBootstrapMe(null);
        void refreshBots(true);
      });
    let refreshTimer: number | undefined;
    const refreshVisibleBots = () => {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void refreshBots().catch(() => undefined), 50);
    };
    window.addEventListener("focus", refreshVisibleBots);
    document.addEventListener("visibilitychange", refreshVisibleBots);
    // Poll skips while a refresh is in flight; focus/visibility and event-driven
    // callers still bump botsRefreshEpoch so only the latest response applies.
    const poll = window.setInterval(() => {
      if (botsRefreshInFlight.current > 0) return;
      refreshVisibleBots();
      // Live events and focus refresh the Muse right away; this only catches drift.
    }, 10_000);
    return () => {
      cancelled = true;
      window.clearTimeout(refreshTimer);
      window.clearInterval(poll);
      window.removeEventListener("focus", refreshVisibleBots);
      document.removeEventListener("visibilitychange", refreshVisibleBots);
    };
  }, []);
  return {
    bots,
    setBots,
    groups,
    setGroups,
    botsRef,
    initialBotsLoaded,
    bootstrapMe,
    setBootstrapMe,
    refreshBots,
    manuallyUnread,
    markBotReadIfVisible,
  };
}
