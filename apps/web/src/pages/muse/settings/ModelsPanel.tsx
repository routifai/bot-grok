import type { EngineModelsStatus } from "@nova/contracts";
import { useState } from "react";
import { BudgetGroup } from "./BudgetGroup";
import { DefaultModel } from "./DefaultModel";
import { ModelKeys } from "./ModelKeys";

/** Settings > Models: the person's provider keys, the model new chats start on, and their
 * monthly budget. Everything here is the engine's (the keys are probed and sealed there). */
export function ModelsPanel({
  status,
  onChanged,
}: {
  status: EngineModelsStatus;
  /** A key was added or removed: the engine's answer about readiness may have changed. */
  onChanged: () => void;
}) {
  const [keysVersion, setKeysVersion] = useState(0);
  return (
    <div data-testid="models-panel" className="flex flex-col gap-6">
      <ModelKeys
        orgProvides={status.ready}
        onChanged={() => {
          onChanged();
          setKeysVersion((version) => version + 1);
        }}
      />
      <DefaultModel key={keysVersion} harnesses={status.harnesses} />
      <BudgetGroup />
    </div>
  );
}
