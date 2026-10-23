import { useLingui } from "@lingui/react/macro";
import type { Topic, TopicCovered, TopicOpen } from "@superchat/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { daysAgo } from "./topicTime";

/** The topics' wire: `rpc.topics.list` / `rpc.topics.pick`. */
export type TopicsWire = {
  list: (input: { botId: string; days?: number }) => Promise<{ topics: Topic[] }>;
  pick: (input: { botId: string; key: string }) => Promise<unknown>;
};

export const LIVE_TOPICS_WIRE: TopicsWire = {
  list: (input) => rpc.topics.list(input),
  pick: (input) => rpc.topics.pick(input),
};

/** Re-read while the window is in view: a quiet moment writes topics on its own schedule. */
const TOPICS_POLL_MS = 5 * 60_000;

/** The person's topics this week (`null` until the first read), re-read on focus and on
 * `reload`. A failed read keeps what was shown. */
export function useTopics(botId: string | undefined, wire: TopicsWire = LIVE_TOPICS_WIRE) {
  const [topics, setTopics] = useState<Topic[] | null>(null);
  const reading = useRef(false);
  const reload = useCallback(async () => {
    if (!botId || reading.current) return;
    reading.current = true;
    try {
      setTopics((await wire.list({ botId, days: 7 })).topics);
    } catch {
      setTopics((current) => current ?? []);
    } finally {
      reading.current = false;
    }
  }, [botId, wire]);
  useEffect(() => {
    setTopics(null);
    void reload();
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, TOPICS_POLL_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [reload]);
  return { topics, reload };
}

/** The words topics are shown with: when a topic was touched, a day heading, each kind tag. */
export function useTopicWords() {
  const { t, i18n } = useLingui();
  return useMemo(() => {
    const time = (at: number) => i18n.date(new Date(at * 1000), { timeStyle: "short" });
    const date = (at: number) =>
      i18n.date(new Date(at * 1000), { weekday: "short", day: "numeric", month: "short" });
    const day = (at: number, now: Date) => {
      const ago = daysAgo(at, now);
      return ago === 0 ? t`Today` : ago === 1 ? t`Yesterday` : date(at);
    };
    const kinds: Record<TopicCovered["kind"] | TopicOpen["kind"], string> = {
      Decided: t`Decided`,
      Made: t`Made`,
      Found: t`Found`,
      Asked: t`Asked`,
      Open: t`Open`,
      Promised: t`Promised`,
    };
    return {
      time,
      day,
      /** "Today 9:14", "Yesterday 16:05", "Tue 20 Oct". */
      when: (at: number, now: Date) =>
        daysAgo(at, now) <= 1 ? `${day(at, now)} ${time(at)}` : date(at),
      /** A covered line's `YYYY-MM-DD`, worded like a day heading. */
      coveredDay: (iso: string, now: Date) => {
        const at = new Date(`${iso}T12:00:00`).getTime() / 1000;
        return Number.isNaN(at) ? iso : day(at, now);
      },
      kinds,
    };
  }, [t, i18n]);
}
