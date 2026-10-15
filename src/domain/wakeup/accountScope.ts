import type { WakeupTask } from "./types";

/** Account-card configuration edits only dedicated tasks, preserving shared task membership. */
export function getSingleAccountWakeupTasks(tasks: readonly WakeupTask[], accountId: string): WakeupTask[] {
  return tasks.filter((task) => task.accountIds.length === 1 && task.accountIds[0] === accountId);
}
