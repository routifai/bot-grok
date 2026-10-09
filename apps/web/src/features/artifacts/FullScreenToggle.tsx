import { useLingui } from "@lingui/react/macro";
import { Button } from "@nova/ui-web";
import { Maximize2, Minimize2 } from "lucide-react";

/** The "Open full screen" header button shared by every surface that previews an HTML app. */
export function FullScreenToggle({
  fullScreen,
  onToggle,
}: {
  fullScreen: boolean;
  onToggle: () => void;
}) {
  const { t } = useLingui();
  return (
    <Button variant="secondary" size="sm" aria-pressed={fullScreen} onClick={onToggle}>
      {fullScreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
      {fullScreen ? t`Exit full screen` : t`Open full screen`}
    </Button>
  );
}
