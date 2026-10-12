import type { Artifact, AutomationSchedule, Live, LiveTell } from "@superchat/contracts";
import { isDeckArtifactName } from "@superchat/contracts";
import { useCallback, useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";
import { useVisiblePoll } from "../../lib/use-visible-poll";

/** Only an HTML page that is not a deck can be kept updated. */
export const canBeLive = (artifact: Artifact | undefined): artifact is Artifact =>
  !!artifact && artifact.mimeType === "text/html" && !isDeckArtifactName(artifact.name);

export type LiveSettingsInput = {
  schedule: AutomationSchedule;
  sources: string[];
  tell: LiveTell;
};

const CHECK_MS = 3_000;

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";

/**
 * A page's live settings and the actions on them. `live` is `undefined` while loading, `null` when
 * the page is not kept updated. Re-read when another version of the page is shown (an update
 * arrives as one).
 */
export function useLive(artifact: Artifact | undefined) {
  const id = canBeLive(artifact) ? artifact.id : null;
  const [live, setLive] = useState<Live | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // After "Update now": the `checkedAt` it started from, until the run moves it.
  const [waiting, setWaiting] = useState<{ since: number | null } | null>(null);

  useEffect(() => {
    if (!id) {
      setLive(undefined);
      return;
    }
    let cancelled = false;
    rpc.live
      .get({ artifactId: id })
      .then((next) => !cancelled && setLive(next))
      .catch(() => !cancelled && setLive(null));
    return () => {
      cancelled = true;
    };
  }, [id]);

  useVisiblePoll(
    async () => {
      if (!id || !waiting) return;
      const next = await rpc.live.get({ artifactId: id });
      setLive(next);
      if (next?.checkedAt !== waiting.since) setWaiting(null);
    },
    CHECK_MS,
    waiting !== null,
  );

  const act = useCallback(
    async <T>(run: (artifactId: string) => Promise<T>): Promise<T | undefined> => {
      if (!id) return undefined;
      setError(null);
      try {
        return await run(id);
      } catch (cause) {
        setError(messageOf(cause));
        return undefined;
      }
    },
    [id],
  );

  return {
    live,
    error,
    updating: waiting !== null,
    save: (input: LiveSettingsInput & { followPublish?: boolean }) =>
      act(async (artifactId) => {
        setLive(await rpc.live.save({ artifactId, ...input }));
        return true;
      }),
    stop: () =>
      act(async (artifactId) => {
        await rpc.live.stop({ artifactId });
        setLive(null);
        return true;
      }),
    run: () =>
      act(async (artifactId) => {
        await rpc.live.run({ artifactId });
        setWaiting({ since: live?.checkedAt ?? null });
        return true;
      }),
    // The new version arrives through the open page's version poll.
    undo: () => act((artifactId) => rpc.live.undo({ artifactId })),
    accept: (elementId: string) => act((artifactId) => rpc.live.accept({ artifactId, elementId })),
  };
}
