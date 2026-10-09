import { useEffect, useState } from "react";
import { rpc } from "./rpc";

/** The engine's public code on an RPC error (`data.code`: `model_key_required`,
 * `account_suspended`, ...), when it has one. */
export function engineErrorCode(error: unknown): string | undefined {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
  return typeof code === "string" ? code : undefined;
}

/** The error's own message (the API already worded it for the person), or `fallback`. */
export function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function formatUsd(value: number, locale: string): string {
  return new Intl.NumberFormat(locale || "en", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** The engine counts time in epoch seconds. */
export function formatEngineDate(seconds: number | null, locale: string): string {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleDateString(locale || "en", {
    month: "short",
    day: "numeric",
  });
}

export type ModelsSettingsSection = "models" | "organization";

const OPEN_SETTINGS_EVENT = "nova:open-settings";

/** Asks the Shell to open Settings at a section, from anywhere (a note in the Conversation). */
export function requestOpenSettings(section: ModelsSettingsSection): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: section }));
}

/** Calls `onOpen` when `requestOpenSettings` fires. */
export function useOpenSettingsRequests(onOpen: (section: ModelsSettingsSection) => void): void {
  useEffect(() => {
    const listener = (event: Event) => {
      const section = (event as CustomEvent<unknown>).detail;
      if (section === "models" || section === "organization") onOpen(section);
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, listener);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, listener);
  }, [onOpen]);
}

type Status = Awaited<ReturnType<typeof rpc.engineModels.status>>;

/** What the engine's model layer says about this person. `status` is `null` until the first
 * answer and when the engine cannot be asked (`settled` tells which); `enabled: false` means
 * Nova runs without the engine. `refresh` asks again. */
export function useEngineModelsStatus(
  active = true,
): [status: Status | null, refresh: () => void, settled: boolean] {
  const [status, setStatus] = useState<Status | null>(null);
  const [settled, setSettled] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void Promise.resolve()
      .then(() => rpc.engineModels.status())
      .then((next) => {
        if (cancelled) return;
        setStatus(next);
        setSettled(true);
      })
      .catch(() => {
        if (cancelled) return;
        setStatus(null);
        setSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [active, version]);
  return [status, () => setVersion((v) => v + 1), settled];
}
