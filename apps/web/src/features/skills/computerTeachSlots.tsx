import type { ComputerStatus, TaughtSkill } from "@nova/contracts";
import type { ComputerTeachSlots } from "../computer";
import { TeachCaptureOverlay } from "./teach/TeachCaptureOverlay";
import { TeachComputerOverlayControl } from "./teach/TeachComputerOverlay";
import { TeachRecordingChrome, TeachStopButton } from "./teach/TeachRecordingChrome";

// Mirrors ENGINE_COMPUTER_ID (core/node): teaching on the engine records it as the control lease.
const ENGINE_TEACH_LEASE = "engine";

/** The teaching parts of the Computer's full-window view, for the shell to hand to it. */
export function computerTeachSlots({
  recordingSkill,
  computer,
  teachBusy,
  stopTeaching,
  refreshActiveTeaching,
}: {
  recordingSkill: TaughtSkill | null;
  computer: ComputerStatus | null;
  teachBusy: boolean;
  stopTeaching: () => Promise<void>;
  refreshActiveTeaching: () => Promise<void>;
}): ComputerTeachSlots {
  // On the engine the person demonstrates straight into the interactive stream (the engine holds
  // control); Nova's capture overlay would sit on top of it and swallow every click and key.
  const teachesOnEngine = recordingSkill?.recording.controlLeaseId === ENGINE_TEACH_LEASE;
  return {
    recording: Boolean(recordingSkill),
    capturesInput: Boolean(recordingSkill) && !teachesOnEngine,
    recordingChrome: recordingSkill ? (
      <TeachRecordingChrome
        recording={recordingSkill}
        busy={teachBusy}
        onStop={stopTeaching}
        variant="overlay"
      />
    ) : null,
    stopButton: <TeachStopButton busy={teachBusy} onStop={stopTeaching} />,
    startControl: (botId) => (
      <TeachComputerOverlayControl
        key={botId}
        botId={botId}
        computer={computer}
        busy={teachBusy}
        onRefresh={refreshActiveTeaching}
      />
    ),
    captureOverlay: (botId) =>
      teachesOnEngine ? null : (
        <TeachCaptureOverlay
          botId={botId}
          skill={recordingSkill}
          enabled={Boolean(recordingSkill)}
          screenWidth={computer?.screenWidth}
          screenHeight={computer?.screenHeight}
        />
      ),
  };
}
