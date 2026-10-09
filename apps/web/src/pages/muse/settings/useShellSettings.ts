import { useEffect, useState } from "react";
import { useOpenSettingsRequests } from "../../../lib/open-settings";
import { rpc } from "../../../lib/rpc";
import type { SettingsSection } from "../../SettingsOverlay";

/** Which settings surfaces are open, plus the messaging status and usage they show. */
export function useShellSettings(user: unknown) {
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [messagingSettingsOpen, setMessagingSettingsOpen] = useState(false);
  const [messagingSurfaceEnabled, setMessagingSurfaceEnabled] = useState(false);
  const [messagingProviders, setMessagingProviders] = useState<string[]>([]);
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void rpc.messaging
      .status()
      .then((status) => {
        if (!cancelled) {
          setMessagingSurfaceEnabled(status.enabled);
          setMessagingProviders(status.providers);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [user]);
  const [usage, setUsage] = useState<{
    inputTokens: number;
    outputTokens: number;
    runs: number;
  } | null>(null);
  function openSettings(section: SettingsSection = "general") {
    setSettingsSection(section);
    setSettingsOpen(true);
  }
  // A note in the Conversation ("Add your API key") opens Settings at Models.
  useOpenSettingsRequests(openSettings);
  return {
    pluginsOpen,
    setPluginsOpen,
    mcpOpen,
    setMcpOpen,
    settingsOpen,
    setSettingsOpen,
    settingsSection,
    setSettingsSection,
    messagingSettingsOpen,
    setMessagingSettingsOpen,
    messagingSurfaceEnabled,
    messagingProviders,
    usage,
    setUsage,
    openSettings,
  };
}
