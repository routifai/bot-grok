import type { Routine, ThreadSnapshot } from "@aiden/contracts";
import { isActive } from "@aiden/core";
import { Trans } from "@lingui/react/macro";
import { RoutineListHeader, RoutineListRow } from "../../RoutineEditor";

/** The routines scheduled for the Muse, under the computer preview. */
export function RoutineList({
  routines,
  run,
  onCreate,
  onOpen,
  onStop,
}: {
  routines: Routine[];
  run: ThreadSnapshot["run"] | undefined;
  onCreate: () => void;
  onOpen: (routine: Routine) => void;
  onStop: () => void;
}) {
  return (
    <>
      <RoutineListHeader onCreate={onCreate} />
      {routines.length === 0 ? (
        <p className="text-[13.5px] text-muted-foreground">
          <Trans>Nothing scheduled yet.</Trans>
        </p>
      ) : null}
      {routines.map((routine) => (
        <RoutineListRow
          key={routine.id}
          routine={routine}
          running={run?.routineId === routine.id && isActive(run.status)}
          onOpen={() => onOpen(routine)}
          onStop={onStop}
        />
      ))}
    </>
  );
}
