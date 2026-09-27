// Adapted from OpenMuse (MIT) — openmuse/prompts.py (ADVANCE_GOAL_PROMPT, CHECK_IN_PROMPT).
// Rewritten for Aiden's `goals` tool actions (create/get/list/update_task/propose instead
// of goals/update_step), CONTEXT.md's Task/Proposal/Check-in words, and Aiden's plain final
// reply (there is no `terminate` tool: a turn just ends with its text).
import type { Goal } from "@aiden/contracts";
import { renderGoal } from "./goals-context.js";

/**
 * `goal.advance`'s task prompt (packages/adapters/src/muse/goal-jobs.ts). The Goal itself
 * is not interpolated here: a Goal-log turn already sees it rendered in full via the
 * automatic `<goals_active>` context (packages/adapters/src/muse/goals-context.ts, B5),
 * since the run's thread is that Goal's log (`thread.goalId` set).
 */
export const ADVANCE_GOAL_TASK_PROMPT = `Continue working on this Goal on the person's behalf (background session).

Instructions:
- Work on the next pending or in-progress Task(s) using your tools. Mark a Task in_progress when you start and done when finished (goals action=update_task), adding a short note with the outcome.
- If a Task is blocked (needs the person, credentials, or a decision), mark it blocked with a note explaining why, and move on to Tasks that do not depend on it.
- If what you learn means the plan should change (a Task is impossible, the order is wrong, or something important is missing), use goals action=propose with the reason and the revised remaining Tasks instead of editing the plan yourself; the person accepts or dismisses it. Keep working on the still-valid Tasks while it waits.
- Do not invent results. End your reply with a short first-person report for the person: what moved, what's next, and what's blocked — one to three sentences, nothing else. That report is posted to them directly, so it must stand on its own.`;

/**
 * `goal.checkin`'s task prompt, run directly in the Muse's Conversation thread — the Goal
 * is embedded in full here (unlike the advance prompt above) because a check-in's thread
 * is the Conversation, not that Goal's log, so the automatic per-Goal context would not
 * single it out among the Muse's other active Goals.
 */
export function renderCheckInTaskPrompt(goal: Goal, today: Date = new Date()): string {
  const todayIso = today.toISOString().slice(0, 10);
  const rendered = renderGoal(goal).join("\n");
  return `It is check-in time for one of the person's Goals (background session, you start the conversation).

${rendered}

Today is ${todayIso}. Write ONE short, warm message to the person — a friend who remembers what they set out to do, not a project manager:
- Remind them in a sentence what this Goal is about and what the next small step is.
- Ask how it is going, or nudge them toward the next step if it is something only they can do.
- If the due date is close or passed, say so plainly and offer to adjust the plan.
- If a Task's note says it is waiting on them, that is what to ask about.
Do not do any work on the Goal in this session, and call no tools. Reply with only that one message. Never reply with exactly NO_RESPONSE: a check-in the person asked for is always delivered.`;
}
