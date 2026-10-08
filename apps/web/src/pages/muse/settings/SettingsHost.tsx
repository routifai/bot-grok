import type { Bot, Me, VoiceStatus } from "@nova/contracts";
import { type Dispatch, lazy, type SetStateAction } from "react";
import { rpc } from "../../../lib/rpc";

import { museMode } from "../chrome/museMode";
import type { useShellSettings } from "./useShellSettings";

const SettingsOverlay = lazy(() =>
  import("../../SettingsOverlay").then((module) => ({ default: module.SettingsOverlay })),
);

/** Bound Settings leave so a hung voice status refresh cannot block dismissal. */
const VOICE_STATUS_REFRESH_TIMEOUT_MS = 10_000;

function voiceStatusRefreshTimeout(): Promise<never> {
  return new Promise((_, reject) => {
    AbortSignal.timeout(VOICE_STATUS_REFRESH_TIMEOUT_MS).addEventListener("abort", () => {
      reject(new DOMException("Voice status refresh timed out", "TimeoutError"));
    });
  });
}

/** The account Settings overlay, wired to the Shell's state. */
export function SettingsHost({
  settings,
  userName,
  email,
  bootstrapMe,
  setBootstrapMe,
  setVoiceStatus,
  active,
  refreshBots,
}: {
  settings: ReturnType<typeof useShellSettings>;
  userName: string;
  email: string | undefined;
  bootstrapMe: Me | null | undefined;
  setBootstrapMe: Dispatch<SetStateAction<Me | null | undefined>>;
  setVoiceStatus: Dispatch<SetStateAction<VoiceStatus | null>>;
  active: Bot | undefined;
  refreshBots: () => Promise<void>;
}) {
  const {
    settingsOpen,
    setSettingsOpen,
    settingsSection,
    setSettingsSection,
    setMessagingSettingsOpen,
    messagingSurfaceEnabled,
    usage,
  } = settings;
  if (!settingsOpen) return null;
  return (
    <SettingsOverlay
      name={userName}
      email={email}
      usage={usage}
      initialSection={settingsSection}
      avatarStyle={bootstrapMe?.avatarStyle ?? "robot"}
      isDeploymentOwner={bootstrapMe?.isDeploymentOwner === true}
      sandboxProvider={bootstrapMe?.sandboxProvider}
      messagingEnabled={messagingSurfaceEnabled}
      onOpenMessaging={() => {
        setSettingsOpen(false);
        setMessagingSettingsOpen(true);
      }}
      onAvatarStyleChange={async (avatarStyle) => {
        const nextMe = await rpc.preferences.update({ avatarStyle });
        setBootstrapMe(nextMe);
      }}
      onVoiceStatusMaybeChanged={async () => {
        try {
          setVoiceStatus(await Promise.race([rpc.voice.status(), voiceStatusRefreshTimeout()]));
        } catch {
          // Prefer reopening Voice settings over CallView with stale readiness.
          setVoiceStatus(null);
        }
      }}
      onClose={() => {
        setSettingsOpen(false);
        setSettingsSection("general");
      }}
      museMode={museMode}
      museBot={museMode ? (active ?? null) : null}
      onMuseBotSave={async (patch) => {
        if (!active) return;
        await rpc.bots.update({ botId: active.id, ...patch });
        await refreshBots();
      }}
    />
  );
}
