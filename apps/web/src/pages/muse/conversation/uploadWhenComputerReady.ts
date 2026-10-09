/** How long a send waits for a Computer that is starting (the managed launch window). */
export const COMPUTER_LAUNCH_WINDOW_MS = 120_000;
const RETRY_EVERY_MS = 3_000;

/**
 * Runs one workspace upload, waiting out a Computer that is still starting.
 *
 * The engine answers a write or listing with "starting" after about 12 seconds while the launch
 * keeps running, so each retry joins the same launch. `onStarting` fires once the wait begins;
 * the last "starting" error is rethrown when the launch window has passed.
 */
export async function uploadWhenComputerReady<T>(
  attempt: () => Promise<T>,
  isStarting: (error: unknown) => boolean,
  onStarting: () => void,
): Promise<T> {
  const deadline = Date.now() + COMPUTER_LAUNCH_WINDOW_MS;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (!isStarting(error) || Date.now() + RETRY_EVERY_MS > deadline) throw error;
      onStarting();
      await new Promise((resolve) => setTimeout(resolve, RETRY_EVERY_MS));
    }
  }
}
