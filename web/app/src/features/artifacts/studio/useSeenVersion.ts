import { useEffect, useState } from "react";

const key = (groupId: string) => `superchat.studio.seen.${groupId}`;

function read(groupId: string): number | null {
  try {
    const value = Number(localStorage.getItem(key(groupId)));
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function write(groupId: string, version: number): void {
  try {
    localStorage.setItem(key(groupId), String(version));
  } catch {
    // Storage blocked: the divider is a convenience, nothing else depends on it.
  }
}

/**
 * The newest version of the file the person saw on their last visit to its studio (null on the
 * first, or without storage), read once when the studio opens; the newest version shown now is
 * remembered for the next visit. Kept in this browser only, per file group.
 */
export function useSeenVersion(groupId: string | null, newest: number | null): number | null {
  const [seen, setSeen] = useState<{ groupId: string; version: number | null } | null>(null);
  useEffect(() => {
    if (groupId) setSeen({ groupId, version: read(groupId) });
  }, [groupId]);
  useEffect(() => {
    if (groupId && newest) write(groupId, newest);
  }, [groupId, newest]);
  return seen?.groupId === groupId ? seen.version : null;
}
