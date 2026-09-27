import type { ComponentProps } from "react";
import { AppRail } from "../../components/AppRail";
import { useAsks } from "./asks";

type MuseRailProps = Omit<
  Extract<ComponentProps<typeof AppRail>, { museMode: true }>,
  "museMode" | "askCount"
> & { botId: string };

/** The Muse-mode rail, with the avatar's badge fed by the shared open-Ask count. */
export function MuseRail({ botId, ...props }: MuseRailProps) {
  const { count } = useAsks(botId);
  return <AppRail museMode askCount={count} {...props} />;
}
