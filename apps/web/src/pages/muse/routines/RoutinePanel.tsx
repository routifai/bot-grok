import type { Bot } from "@nova/contracts";
import type { Dispatch, SetStateAction } from "react";
import { localTimezone } from "../../../lib/local-timezone";
import { RoutineEditor } from "../../RoutineEditor";
import type { Panel } from "../chrome/panel";
import type { useRoutineEditor } from "./useRoutineEditor";

/** The routine editor, wired to its draft state. */
export function RoutinePanel({
  editor,
  active,
  messagingProviders,
  setPanel,
}: {
  editor: ReturnType<typeof useRoutineEditor>;
  active: Bot;
  messagingProviders: string[];
  setPanel: Dispatch<SetStateAction<Panel>>;
}) {
  const {
    routineDraft,
    setRoutineDraft,
    editingRoutine,
    routineWebhookSecret,
    savingRoutine,
    runningRoutine,
    routineError,
    ensureWebhookSecret,
    saveRoutine,
    testRunRoutine,
    requestDelete,
  } = editor;
  return (
    <RoutineEditor
      draft={routineDraft}
      onChange={setRoutineDraft}
      editing={editingRoutine}
      timezone={editingRoutine?.timezone ?? localTimezone()}
      webhook={{
        path:
          typeof window !== "undefined"
            ? `${window.location.origin}/api/v1/bots/${active.id}/webhook`
            : `/api/v1/bots/${active.id}/webhook`,
        secret: routineWebhookSecret,
        configured: active.webhookConfigured || Boolean(routineWebhookSecret),
      }}
      githubPath={
        typeof window !== "undefined"
          ? `${window.location.origin}/api/v1/bots/${active.id}/github`
          : `/api/v1/bots/${active.id}/github`
      }
      messageProviders={messagingProviders}
      saving={savingRoutine}
      running={runningRoutine}
      error={routineError}
      onBack={() => setPanel("computer")}
      onClose={() => setPanel(null)}
      onEnsureWebhook={async () => {
        await ensureWebhookSecret(active.id);
      }}
      onSave={saveRoutine}
      onTestRun={testRunRoutine}
      onDelete={requestDelete}
    />
  );
}
