import type { Bot, Routine, ThreadSnapshot } from "@aiden/contracts";
import { cronFromPreset } from "@aiden/core";
import { useLingui } from "@lingui/react/macro";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { localTimezone } from "../../../lib/local-timezone";
import { rpc } from "../../../lib/rpc";
import { sharedInflight } from "../../../lib/shared-inflight";
import {
  draftFromRoutine,
  emptyRoutineDraft,
  type RoutineDraftState,
  routineNeedsOneShotArm,
} from "../../RoutineEditor";
import type { Panel } from "../chrome/panel";

/** The routine editor panel: draft state, save, test run and delete. */
export function useRoutineEditor({
  active,
  activeBotId,
  setPanel,
  panel,
  setBots,
  refreshThread,
}: {
  active: Bot | undefined;
  activeBotId: MutableRefObject<string | undefined>;
  panel: Panel;
  setPanel: Dispatch<SetStateAction<Panel>>;
  setBots: Dispatch<SetStateAction<Bot[]>>;
  refreshThread: (id: string, signal?: AbortSignal) => Promise<ThreadSnapshot>;
}) {
  const { t } = useLingui();
  const [routineDraft, setRoutineDraft] = useState<RoutineDraftState>(emptyRoutineDraft());
  const [routineWebhookSecret, setRoutineWebhookSecret] = useState<string | null>(null);
  const [editingRoutine, setEditingRoutine] = useState<Routine | null>(null);
  const [deleteRoutineTarget, setDeleteRoutineTarget] = useState<Routine | null>(null);
  const [savingRoutine, setSavingRoutine] = useState(false);
  const [runningRoutine, setRunningRoutine] = useState(false);
  const [routineError, setRoutineError] = useState<string | null>(null);
  const routineSavePending = useRef(false);
  const webhookSecretProvisionRef = useRef(new Map<string, Promise<string>>());
  const ensureWebhookSecret = (botId: string) =>
    sharedInflight(webhookSecretProvisionRef.current, botId, async () => {
      const result = await rpc.bots.rotateWebhookSecret({ botId });
      setRoutineWebhookSecret(result.secret);
      setBots((current) =>
        current.map((bot) => (bot.id === botId ? { ...bot, webhookConfigured: true } : bot)),
      );
      return result.secret;
    });
  const routineSaveRequest = useRef(0);
  const routineRunPending = useRef(false);

  useEffect(() => {
    if (panel !== "routine") {
      routineSaveRequest.current += 1;
      setRoutineError(null);
    }
  }, [panel]);

  // The routine panel copies a routine's data into local draft state at click time
  // rather than deriving it from `active`, so it goes stale across a bot switch —
  // without this, Save on bot B could silently update bot A's routine.
  useEffect(() => {
    setEditingRoutine(null);
    setDeleteRoutineTarget(null);
    setPanel((current) => (current === "routine" ? null : current));
  }, [active?.id]);

  const addSkillRoutine = useCallback((name: string, prompt: string) => {
    setRoutineDraft({ ...emptyRoutineDraft(), name, prompt });
    setRoutineWebhookSecret(null);
    setEditingRoutine(null);
    setPanel("routine");
  }, []);

  function openNew() {
    setRoutineDraft(emptyRoutineDraft());
    setRoutineWebhookSecret(null);
    setEditingRoutine(null);
    setRoutineError(null);
    setPanel("routine");
  }

  function openRoutine(routine: Routine) {
    setRoutineDraft(draftFromRoutine(routine));
    setRoutineWebhookSecret(null);
    setEditingRoutine(routine);
    setRoutineError(null);
    setPanel("routine");
  }

  async function saveRoutine() {
    if (!active) return;
    if (routineSavePending.current) return;
    const targetBotId = active.id;
    const targetRoutine = editingRoutine;
    if (targetRoutine && targetRoutine.botId !== targetBotId) return;
    if (
      !routineDraft.schedules.length &&
      !routineDraft.webhookEnabled &&
      !routineDraft.githubEnabled &&
      !routineDraft.messageProvider
    ) {
      setRoutineError(t`Add a schedule, webhook, GitHub, or message trigger`);
      return;
    }
    const saveRequest = ++routineSaveRequest.current;
    routineSavePending.current = true;
    setSavingRoutine(true);
    setRoutineError(null);
    try {
      if (
        (routineDraft.webhookEnabled || routineDraft.githubEnabled) &&
        !active.webhookConfigured &&
        !routineWebhookSecret
      ) {
        await ensureWebhookSecret(targetBotId);
      }
      const crons = routineDraft.schedules.map(cronFromPreset);
      let saved: Routine;
      if (targetRoutine) {
        const armOneShot = routineNeedsOneShotArm(targetRoutine, crons);
        let runAt: string | undefined;
        if (armOneShot) {
          if (!routineDraft.runAtLocal) {
            setRoutineError(t`Add a run time for this one-shot.`);
            return;
          }
          const parsed = new Date(routineDraft.runAtLocal);
          if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= Date.now()) {
            setRoutineError(t`Run time must be in the future.`);
            return;
          }
          runAt = parsed.toISOString();
        }
        saved = await rpc.routines.update({
          routineId: targetRoutine.id,
          name: routineDraft.name || t`Routine`,
          prompt: routineDraft.prompt || t`Check in.`,
          crons,
          active: armOneShot ? true : routineDraft.active,
          webhookEnabled: routineDraft.webhookEnabled,
          githubEnabled: routineDraft.githubEnabled,
          messageProvider: routineDraft.messageProvider,
          ...(runAt ? { runAt } : {}),
        });
      } else {
        saved = await rpc.routines.create({
          botId: targetBotId,
          name: routineDraft.name || t`Routine`,
          prompt: routineDraft.prompt || t`Check in.`,
          crons,
          timezone: localTimezone(),
          active: routineDraft.active,
          notify: true,
          webhookEnabled: routineDraft.webhookEnabled,
          githubEnabled: routineDraft.githubEnabled,
          messageProvider: routineDraft.messageProvider,
        });
      }
      if (routineSaveRequest.current === saveRequest && activeBotId.current === targetBotId) {
        setEditingRoutine(saved);
        setRoutineDraft(draftFromRoutine(saved));
      }
    } catch (error) {
      if (routineSaveRequest.current !== saveRequest || activeBotId.current !== targetBotId) {
        return;
      }
      setRoutineError(error instanceof Error ? error.message : t`Could not save routine`);
      return;
    } finally {
      routineSavePending.current = false;
      setSavingRoutine(false);
    }
    if (routineSaveRequest.current !== saveRequest || activeBotId.current !== targetBotId) {
      return;
    }
    await refreshThread(targetBotId).catch(() => undefined);
  }

  async function testRunRoutine() {
    if (!active) return;
    if (routineRunPending.current) return;
    const targetBotId = active.id;
    const targetRoutine = editingRoutine;
    if (!targetRoutine) return;
    routineRunPending.current = true;
    setRunningRoutine(true);
    setRoutineError(null);
    try {
      await rpc.routines.testRun({ routineId: targetRoutine.id });
      await refreshThread(targetBotId);
    } catch (error) {
      if (activeBotId.current === targetBotId) {
        setRoutineError(error instanceof Error ? error.message : t`Could not run routine`);
      }
    } finally {
      routineRunPending.current = false;
      setRunningRoutine(false);
    }
  }

  function requestDelete() {
    if (editingRoutine) {
      setDeleteRoutineTarget(editingRoutine);
      return;
    }
    setPanel("computer");
  }

  async function confirmDeleteRoutine(target: Routine) {
    await rpc.routines.remove({ routineId: target.id });
    setDeleteRoutineTarget(null);
    setEditingRoutine((current) => (current?.id === target.id ? null : current));
    if (activeBotId.current !== target.botId) return;
    await refreshThread(target.botId);
    if (activeBotId.current === target.botId) setPanel("computer");
  }

  return {
    routineDraft,
    setRoutineDraft,
    routineWebhookSecret,
    setRoutineWebhookSecret,
    editingRoutine,
    setEditingRoutine,
    deleteRoutineTarget,
    setDeleteRoutineTarget,
    savingRoutine,
    runningRoutine,
    routineError,
    ensureWebhookSecret,
    addSkillRoutine,
    openNew,
    openRoutine,
    saveRoutine,
    testRunRoutine,
    requestDelete,
    confirmDeleteRoutine,
  };
}
