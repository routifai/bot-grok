import { useCallback, useState } from "react";

export type ComputerView = "screen" | "files";

const STORAGE_KEY = "nova.computerView";

/** Which Computer panel view the person last used, remembered across sessions. */
export function useComputerView(): [ComputerView, (next: ComputerView) => void] {
  const [view, setViewState] = useState<ComputerView>(() => {
    try {
      return window.localStorage.getItem(STORAGE_KEY) === "files" ? "files" : "screen";
    } catch {
      return "screen";
    }
  });
  const setView = useCallback((next: ComputerView) => {
    setViewState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Best-effort; the choice still holds for this session.
    }
  }, []);
  return [view, setView];
}
