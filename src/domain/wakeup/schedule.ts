import type { WakeupTaskInput, WakeupScheduleMode, WakeupQuotaResetWindow } from "./types";
import type { CodexQuotaSummary } from "../../core/types";

export function resolveWakeupScheduleMode(task: Pick<WakeupTaskInput, "scheduleMode" | "days">): WakeupScheduleMode {
  return !task.scheduleMode || task.scheduleMode === "calendar"
    ? new Set(task.days).size === 7
      ? "daily"
      : "weekly"
    : task.scheduleMode;
}

export function collectQuotaResetTimes(quota: CodexQuotaSummary | undefined, window: WakeupQuotaResetWindow): number[] {
  const windows = quota ? [quota, ...(quota.additionalRateLimits ?? [])] : [];
  return [
    ...new Set(
      windows
        .flatMap((item) => [
          ...(window !== "weekly" ? [item.hourlyResetTime] : []),
          ...(window !== "hourly" ? [item.weeklyResetTime] : [])
        ])
        .filter((time): time is number => typeof time === "number" && Number.isFinite(time) && time > 0)
        .map((time) => Math.floor(time < 100_000_000_000 ? time * 1000 : time))
    )
  ].sort((a, b) => a - b);
}

export function nextWakeupAt(
  task: Pick<WakeupTaskInput, "time" | "days" | "scheduleMode" | "intervalMinutes"> & { nextRunAt?: number },
  after: number
): number {
  if (task.scheduleMode === "startup" || task.scheduleMode === "quota_reset") {
    return 0;
  }
  if (task.scheduleMode === "interval") {
    const interval = task.intervalMinutes;
    if (typeof interval !== "number" || !Number.isInteger(interval) || interval < 1 || interval > 10_080) {
      throw new Error("Interval must contain 1–10080 whole minutes");
    }
    const step = interval * 60_000;
    const anchor = task.nextRunAt ?? after + step;
    // Keep the cadence when a poll runs late; skip past occurrences without replaying them.
    return anchor > after ? anchor : anchor + (Math.floor((after - anchor) / step) + 1) * step;
  }
  const [hours = 0, minutes = 0] = task.time.split(":").map(Number);
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(after);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(hours, minutes, 0, 0);
    if ((task.scheduleMode === "daily" || task.days.includes(candidate.getDay())) && candidate.getTime() > after) {
      return candidate.getTime();
    }
  }
  throw new Error("No scheduled weekday is available");
}

export function validateWakeupTask(input: WakeupTaskInput): WakeupTaskInput {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid wakeup task");
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const model = typeof input.model === "string" ? input.model.trim() : "";
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  const { scheduleMode = "calendar" } = input;
  if (!["calendar", "daily", "weekly", "interval", "quota_reset", "startup"].includes(scheduleMode)) {
    throw new Error("Invalid wakeup schedule mode");
  }
  if (
    scheduleMode === "startup" &&
    (typeof input.startupDelayMinutes !== "number" ||
      !Number.isInteger(input.startupDelayMinutes) ||
      input.startupDelayMinutes < 0 ||
      input.startupDelayMinutes > 1440)
  ) {
    throw new Error("Startup delay must contain 0–1440 whole minutes");
  }
  if (scheduleMode === "quota_reset" && !["hourly", "weekly", "either"].includes(input.quotaResetWindow ?? "")) {
    throw new Error("Invalid quota reset window");
  }
  if (
    scheduleMode === "interval" &&
    (typeof input.intervalMinutes !== "number" ||
      !Number.isInteger(input.intervalMinutes) ||
      input.intervalMinutes < 1 ||
      input.intervalMinutes > 10_080)
  ) {
    throw new Error("Interval must contain 1–10080 whole minutes");
  }
  if (!name || name.length > 80) {
    throw new Error("Task name must contain 1–80 characters");
  }
  if (
    ["calendar", "daily", "weekly"].includes(scheduleMode) &&
    (typeof input.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time))
  ) {
    throw new Error("Time must use HH:MM");
  }
  if (
    ["calendar", "weekly"].includes(scheduleMode) &&
    (!Array.isArray(input.days) ||
      !input.days.length ||
      input.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6))
  ) {
    throw new Error("Select at least one weekday");
  }
  if (
    !Array.isArray(input.accountIds) ||
    !input.accountIds.length ||
    input.accountIds.length > 100 ||
    input.accountIds.some((id) => typeof id !== "string" || !id || id.length > 200)
  ) {
    throw new Error("Select 1–100 accounts");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(model)) {
    throw new Error("Invalid model ID");
  }
  if (!["low", "medium", "high"].includes(input.effort)) {
    throw new Error("Invalid reasoning effort");
  }
  if (!prompt || prompt.length > 500) {
    throw new Error("Prompt must contain 1–500 characters");
  }
  if (
    typeof input.enabled !== "boolean" ||
    (input.id !== undefined && (typeof input.id !== "string" || !/^[\w-]{1,100}$/.test(input.id)))
  ) {
    throw new Error("Invalid task state");
  }
  return {
    id: input.id,
    name,
    enabled: input.enabled,
    accountIds: [...new Set(input.accountIds)],
    time: ["calendar", "daily", "weekly"].includes(scheduleMode) ? input.time : "06:15",
    days: ["calendar", "weekly"].includes(scheduleMode)
      ? [...new Set(input.days)].sort((a, b) => a - b)
      : [0, 1, 2, 3, 4, 5, 6],
    scheduleMode,
    ...(scheduleMode === "interval" ? { intervalMinutes: input.intervalMinutes } : {}),
    ...(scheduleMode === "startup" ? { startupDelayMinutes: input.startupDelayMinutes } : {}),
    ...(scheduleMode === "quota_reset" ? { quotaResetWindow: input.quotaResetWindow } : {}),
    model,
    effort: input.effort,
    prompt
  };
}
