import { lazy } from "react";

import type { useShellSettings } from "./useShellSettings";

const MessagingSettingsOverlay = lazy(() =>
  import("../../MessagingSettingsOverlay").then((module) => ({
    default: module.MessagingSettingsOverlay,
  })),
);
const PluginsOverlay = lazy(() =>
  import("../../PluginsOverlay").then((module) => ({ default: module.PluginsOverlay })),
);
const McpServersOverlay = lazy(() =>
  import("../../McpServersOverlay").then((module) => ({ default: module.McpServersOverlay })),
);

/** Plugins, MCP servers and messaging overlays. */
export function IntegrationOverlays({
  settings,
  activeBotId,
}: {
  settings: ReturnType<typeof useShellSettings>;
  activeBotId: string | undefined;
}) {
  const {
    pluginsOpen,
    setPluginsOpen,
    mcpOpen,
    setMcpOpen,
    messagingSettingsOpen,
    setMessagingSettingsOpen,
  } = settings;
  return (
    <>
      {pluginsOpen ? (
        <PluginsOverlay
          activeBotId={activeBotId}
          onClose={() => setPluginsOpen(false)}
          onOpenMcp={() => {
            setPluginsOpen(false);
            setMcpOpen(true);
          }}
        />
      ) : null}
      {mcpOpen ? <McpServersOverlay onClose={() => setMcpOpen(false)} /> : null}
      {messagingSettingsOpen ? (
        <MessagingSettingsOverlay onClose={() => setMessagingSettingsOpen(false)} />
      ) : null}
    </>
  );
}
