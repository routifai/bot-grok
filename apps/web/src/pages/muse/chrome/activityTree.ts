import type { Activity } from "@aiden/contracts";
import { presentStep } from "@aiden/core";
import { isRunning } from "./activityGrouping";

// Helpers nest: a Helper that hands part of its task to others (CONTEXT.md "Helper") lists those
// parts under it. Pure, so the panel row and the chat's tracker share one reading of the feed.

export interface ActivityNode {
  activity: Activity;
  /** Parts of this Helper's task, oldest first. */
  children: ActivityNode[];
}

/** The feed as a forest: a Helper whose `parentChatId` is another listed Helper's chat hangs
 * under it; everything else (turns, Helpers started from the Conversation or a Side Chat, and
 * parts whose parent is not loaded) is a root, in the order given. */
export function buildActivityForest(activities: readonly Activity[]): ActivityNode[] {
  const nodes = new Map<string, ActivityNode>();
  const helperByChat = new Map<string, ActivityNode>();
  for (const activity of activities) {
    const node: ActivityNode = { activity, children: [] };
    nodes.set(activity.id, node);
    if (activity.kind === "sub_agent") helperByChat.set(activity.chatId, node);
  }
  const roots: ActivityNode[] = [];
  for (const activity of activities) {
    const node = nodes.get(activity.id) as ActivityNode;
    const parent =
      activity.kind === "sub_agent" && activity.parentChatId
        ? helperByChat.get(activity.parentChatId)
        : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  for (const node of nodes.values()) {
    node.children.sort(
      (a, b) => Date.parse(a.activity.startedAt) - Date.parse(b.activity.startedAt),
    );
  }
  return roots;
}

/** A node is running while it, or any part under it, is. */
export function isNodeRunning(node: ActivityNode): boolean {
  return isRunning(node.activity) || node.children.some(isNodeRunning);
}

/** The node for a Helper's chat, wherever it sits in the forest. */
export function findHelperNode(
  forest: readonly ActivityNode[],
  helperChatId: string,
): ActivityNode | undefined {
  for (const node of forest) {
    if (node.activity.kind === "sub_agent" && node.activity.chatId === helperChatId) return node;
    const inner = findHelperNode(node.children, helperChatId);
    if (inner) return inner;
  }
  return undefined;
}

/** How many Steps a Helper has taken (its own; parts count under their own row). */
export function stepCount(activity: Pick<Activity, "steps">): number {
  return activity.steps?.length ?? 0;
}

/** What an Activity is doing right now, in plain words: its latest Step's title (never a raw
 * tool name), if it has taken one yet. */
export function latestStepTitle(activity: Pick<Activity, "steps">): string | undefined {
  const step = activity.steps?.at(-1);
  return step ? presentStep(step).title : undefined;
}
