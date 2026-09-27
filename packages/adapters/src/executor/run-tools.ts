// Small run-scoped tool-selection and computer-tool-result helpers used by the
// run executor: which builtin tools a run gets, workspace checkpoint debouncing,
// and wrapping a computer/browser tool result with screen-availability retries.

import type { ProductMode } from "@aiden/contracts";
import { isMuseMode } from "@aiden/core";
import { builtinAgentTools } from "../builtin-tools.js";
import { selectCloudAgentTools } from "../cloud-agent-tools-select.js";
import { withComputerScreenAvailability } from "../computer-screens.js";
import { selectMemoryTools } from "../memory-tools.js";
import { filterImageReturningComputerTools } from "../model-vision.js";
import { filterBuiltinToolsForRun, filterBuiltinToolsForThread } from "../schedule-tools.js";

/**
 * ADR 0001: in muse mode there is exactly one Muse per person, so peer-bot
 * creation and management tools are locked out of the runtime's tool list.
 * `run_subagent` (a Helper, not a bot) stays available.
 */
export const MUSE_LOCKED_TOOL_NAMES = new Set([
  "spawn_bot",
  "update_bot",
  "archive_bot",
  "message_bot",
  "handoff_to_bot",
  "create_space",
]);

export function createRunWorkspaceCheckpoint(checkpoint: () => Promise<unknown>) {
  let dirty = false;
  return {
    markDirty() {
      dirty = true;
    },
    markFiles(files: readonly unknown[]) {
      if (files.length > 0) dirty = true;
    },
    async flush() {
      if (!dirty) return false;
      dirty = false;
      try {
        await checkpoint();
        return true;
      } catch (error) {
        dirty = true;
        throw error;
      }
    },
  };
}

export async function computerScreenToolResult(
  work: () => Promise<unknown>,
  finish?: (result: unknown) => Promise<unknown>,
) {
  const result = await withComputerScreenAvailability(work);
  return finish ? finish(result) : result;
}

export function computerRetryDelay(fence: number): number {
  return Math.min(10_000, 250 * 2 ** Math.min(Math.max(fence - 1, 0), 5));
}

export function selectBuiltinToolsForRun(options: {
  graphicalToolsAllowed: boolean;
  /** Page browser tools need a graphical computer (Chrome), not model vision. */
  pageBrowserAllowed?: boolean;
  groupId: string | null;
  trigger: string;
  semanticMemoryEnabled: boolean;
  cloudAgentEnabled?: boolean;
  messagingChannelRun: boolean;
  /** Defaults to upstream Rakazo (peer-bot tools stay available) when absent. */
  productMode?: ProductMode;
}) {
  return selectCloudAgentTools(
    selectMemoryTools(
      filterBuiltinToolsForRun(
        filterBuiltinToolsForThread(
          filterPageBrowserTools(
            filterImageReturningComputerTools(builtinAgentTools, options.graphicalToolsAllowed),
            options.pageBrowserAllowed ?? options.graphicalToolsAllowed,
          ),
          options.groupId,
        ),
        options.trigger,
      ),
      options.semanticMemoryEnabled,
    ),
    Boolean(options.cloudAgentEnabled),
  )
    .filter(
      (tool) =>
        !options.messagingChannelRun ||
        (!["remember", "save_memory", "recall_memory", "forget_memory", "task_catalog"].includes(
          tool.name,
        ) &&
          !tool.name.startsWith("scratchpad_")),
    )
    .filter(
      (tool) =>
        !isMuseMode(options.productMode ?? "aiden") || !MUSE_LOCKED_TOOL_NAMES.has(tool.name),
    );
}

export const PAGE_BROWSER_TOOL_NAMES = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
]);

export function filterPageBrowserTools<T extends { name: string }>(
  tools: T[],
  pageBrowserAllowed: boolean,
): T[] {
  if (pageBrowserAllowed) return tools;
  return tools.filter((tool) => !PAGE_BROWSER_TOOL_NAMES.has(tool.name));
}
