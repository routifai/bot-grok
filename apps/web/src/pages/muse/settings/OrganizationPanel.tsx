import { useLingui } from "@lingui/react/macro";
import type { EngineModelsStatus } from "@nova/contracts";
import { useState } from "react";
import { BudgetGroup } from "./BudgetGroup";
import { SettingsGroup, SettingsSegmented } from "./kit";
import { ModelKeys } from "./ModelKeys";
import { OrgModels } from "./OrgModels";
import { OrgUsage } from "./OrgUsage";
import { OrgUsers } from "./OrgUsers";

type Area = "people" | "usage" | "keys" | "models" | "budget";

/** Settings > Organization (admins only): people, usage, the organization's keys, the models it
 * offers and its budget. The engine enforces who may see any of it. */
export function OrganizationPanel({
  status,
  selfEmail,
}: {
  status: EngineModelsStatus;
  selfEmail?: string | null;
}) {
  const { t } = useLingui();
  const [area, setArea] = useState<Area>("people");
  return (
    <div data-testid="organization-panel" className="flex flex-col gap-6">
      <SettingsGroup>
        <SettingsSegmented
          label={t`Organization`}
          testId="org-area"
          value={area}
          options={[
            { value: "people", label: t`People` },
            { value: "usage", label: t`Usage` },
            { value: "keys", label: t`Keys` },
            { value: "models", label: t`Models` },
            { value: "budget", label: t`Budget` },
          ]}
          onChange={setArea}
        />
      </SettingsGroup>
      {area === "people" ? <OrgUsers selfEmail={selfEmail} /> : null}
      {area === "usage" ? <OrgUsage /> : null}
      {area === "keys" ? <ModelKeys scope="org" /> : null}
      {area === "models" ? <OrgModels harnesses={status.harnesses} /> : null}
      {area === "budget" ? <BudgetGroup scope="org" /> : null}
    </div>
  );
}
