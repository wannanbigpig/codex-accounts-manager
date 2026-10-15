export type WakeupEffort = "low" | "medium" | "high";
export type WakeupScheduleMode = "daily" | "weekly" | "interval" | "quota_reset" | "startup";
export type WakeupQuotaResetWindow = "hourly" | "weekly" | "either";

export interface WakeupTaskInput {
  id?: string;
  name: string;
  enabled: boolean;
  accountIds: string[];
  time: string;
  /** Local weekdays: Sunday = 0. */
  days: number[];
  /** Missing on existing tasks, which use the calendar schedule. */
  scheduleMode?: "calendar" | WakeupScheduleMode;
  intervalMinutes?: number;
  quotaResetWindow?: WakeupQuotaResetWindow;
  startupDelayMinutes?: number;
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
  startupSessionId?: string;
  lastStartupSessionId?: string;
  nextRunAccountIds?: string[];
  quotaResetSnapshots?: Record<string, { observedAt: number; times: number[] }>;
}

export type WakeupRunStatus = "running" | "success" | "partial" | "failed" | "cancelled" | "interrupted" | "missed";
export type WakeupErrorStage = "auth" | "request" | "stream" | "timeout" | "cancelled";
export interface WakeupExecutionResult {
  reply: string;
  model?: string;
  quotaWarning?: string;
}

export interface WakeupAccountResult {
  accountId: string;
  status: "success" | "failed" | "cancelled";
  message?: string;
  durationMs?: number;
  reply?: string;
  model?: string;
  quotaWarning?: string;
  errorStage?: WakeupErrorStage;
  httpStatus?: number;
}

export interface WakeupRun {
  id: string;
  taskId: string;
  taskName: string;
  model?: string;
  effort?: WakeupEffort;
  trigger: "scheduled" | "manual";
  scheduledAt?: number;
  startedAt: number;
  finishedAt?: number;
  ownerPid: number;
  status: WakeupRunStatus;
  results: WakeupAccountResult[];
}

export interface WakeupState {
  /** New formats are rejected by older hosts, so they cannot execute unsupported schedules. */
  version: 4;
  timeZone: string;
  tasks: WakeupTask[];
  history: WakeupRun[];
  startupSession?: { id: string; startedAt: number };
}

export interface WakeupSnapshot extends WakeupState {
  storageError?: string;
}

export const DEFAULT_WAKEUP_MODEL = "gpt-5.6-luna";
export const DEFAULT_WAKEUP_PROMPT = "Reply with OK.";
export const WAKEUP_GRACE_MS = 5 * 60_000;
