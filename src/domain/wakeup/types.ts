export type WakeupEffort = "low" | "medium" | "high";

export interface WakeupTaskInput {
  id?: string;
  name: string;
  enabled: boolean;
  accountIds: string[];
  time: string;
  /** Local weekdays: Sunday = 0. */
  days: number[];
  /** Missing on existing tasks, which use the calendar schedule. */
  scheduleMode?: "calendar" | "interval";
  intervalMinutes?: number;
  model: string;
  effort: WakeupEffort;
  prompt: string;
}

export interface WakeupTask extends WakeupTaskInput {
  id: string;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number;
  lastScheduledAt?: number;
}

export type WakeupRunStatus = "running" | "success" | "partial" | "failed" | "cancelled" | "interrupted" | "missed";

export interface WakeupAccountResult {
  accountId: string;
  status: "success" | "failed" | "cancelled";
  message?: string;
}

export interface WakeupRun {
  id: string;
  taskId: string;
  taskName: string;
  trigger: "scheduled" | "manual";
  scheduledAt?: number;
  startedAt: number;
  finishedAt?: number;
  ownerPid: number;
  status: WakeupRunStatus;
  results: WakeupAccountResult[];
}

export interface WakeupState {
  /** Version 2 prevents older schedulers from treating interval tasks as calendar tasks. */
  version: 1 | 2;
  enabled: boolean;
  timeZone: string;
  tasks: WakeupTask[];
  history: WakeupRun[];
}

export interface WakeupSnapshot extends WakeupState {
  storageError?: string;
}

export const DEFAULT_WAKEUP_MODEL = "gpt-5.6-luna";
export const DEFAULT_WAKEUP_PROMPT = "Reply with OK.";
export const WAKEUP_GRACE_MS = 5 * 60_000;
