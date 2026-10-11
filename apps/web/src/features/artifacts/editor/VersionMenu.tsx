import { useLingui } from "@lingui/react/macro";
import type { ArtifactVersion } from "@superchat/contracts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@superchat/ui-web";
import { Check, ChevronDown, History } from "lucide-react";
import { useState } from "react";
import { formatRelativeTime } from "../../../lib/relative-time";

/**
 * "<Kind> · version N ▾" beside the title: every version with who made it and when; picking one
 * shows it, and "Restore this version" makes the one on screen the newest again (a new version,
 * nothing is lost).
 */
export function VersionMenu({
  kindLabel,
  version,
  versions,
  shownId,
  onPick,
  onRestore,
}: {
  kindLabel: string;
  /** The version on screen, for before (or without) the version list. */
  version: number;
  /** Newest first. */
  versions: readonly ArtifactVersion[];
  shownId: string | null;
  onPick: (versionId: string) => void;
  /** Restores the version on screen; resolves when the new version is saved. */
  onRestore: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [restoring, setRestoring] = useState(false);
  const [failed, setFailed] = useState(false);
  const shown = versions.find((entry) => entry.id === shownId) ?? versions[0];
  const label = t`${kindLabel} · version ${shown?.version ?? version}`;
  if (versions.length < 2) {
    return (
      <span data-testid="version-label" className="shrink-0 text-[12px] text-muted-foreground">
        {label}
      </span>
    );
  }
  const latest = versions[0];
  const older = !!shown && !!latest && shown.id !== latest.id;
  const origin = (entry: ArtifactVersion) =>
    entry.origin === "manual"
      ? t`by you`
      : entry.origin === "restore"
        ? t`restored`
        : t`by superchat`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="version-menu"
        className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {label}
        <ChevronDown size={12} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t`Versions`}</DropdownMenuLabel>
          {versions.map((entry, index) => (
            <DropdownMenuItem
              key={entry.id}
              data-testid="version-item"
              onClick={() => onPick(entry.id)}
              className="gap-2"
            >
              <Check
                size={14}
                aria-hidden="true"
                className={entry.id === shown?.id ? "" : "invisible"}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[13px]">
                  {index === 0 ? t`Version ${entry.version} · latest` : t`Version ${entry.version}`}
                </span>
                <span className="truncate text-[11.5px] text-muted-foreground">
                  {[origin(entry), formatRelativeTime(entry.createdAt)].filter(Boolean).join(" · ")}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        {older ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid="version-restore"
              disabled={restoring}
              onClick={async () => {
                setRestoring(true);
                setFailed(false);
                try {
                  await onRestore();
                } catch {
                  setFailed(true);
                } finally {
                  setRestoring(false);
                }
              }}
            >
              <History size={14} aria-hidden="true" />
              {failed ? t`Couldn't restore. Try again` : t`Restore this version`}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
