import { CodexQuotaSummary } from "../core/types";

const MAX_HOURLY_WINDOW_MINUTES = 360;
const MIN_WEEKLY_WINDOW_MINUTES = 1440;

type QuotaWindowSnapshot = {
  slot: "hourly" | "weekly";
  percentage: number;
  resetTime?: number;
  windowMinutes?: number;
};

export function normalizeQuotaSummary(summary?: CodexQuotaSummary): CodexQuotaSummary | undefined {
  if (!summary) {
    return summary;
  }

  const hourlyWindow = createQuotaWindowSnapshot(
    "hourly",
    summary.hourlyWindowPresent,
    summary.hourlyPercentage,
    summary.hourlyResetTime,
    summary.hourlyWindowMinutes
  );
  const weeklyWindow = createQuotaWindowSnapshot(
    "weekly",
    summary.weeklyWindowPresent,
    summary.weeklyPercentage,
    summary.weeklyResetTime,
    summary.weeklyWindowMinutes
  );

  const classified = classifyQuotaWindows([hourlyWindow, weeklyWindow].filter(Boolean) as QuotaWindowSnapshot[]);
  const resolvedHourly = classified.hourly ?? (isHourlyWindow(hourlyWindow) ? hourlyWindow : undefined);
  const resolvedWeekly = classified.weekly ?? (isWeeklyWindow(weeklyWindow) ? weeklyWindow : undefined);

  return {
    hourlyPercentage: resolvedHourly?.percentage ?? 0,
    hourlyResetTime: resolvedHourly?.resetTime,
    hourlyWindowMinutes: resolvedHourly?.windowMinutes,
    hourlyWindowPresent: Boolean(resolvedHourly),
    weeklyPercentage: resolvedWeekly?.percentage ?? 0,
    weeklyResetTime: resolvedWeekly?.resetTime,
    weeklyWindowMinutes: resolvedWeekly?.windowMinutes,
    weeklyWindowPresent: Boolean(resolvedWeekly),
    codeReviewPercentage: summary.codeReviewPercentage,
    codeReviewResetTime: summary.codeReviewResetTime,
    codeReviewWindowMinutes: summary.codeReviewWindowMinutes,
    codeReviewWindowPresent: summary.codeReviewWindowPresent,
    rawData: summary.rawData
  };
}

function createQuotaWindowSnapshot(
  slot: "hourly" | "weekly",
  present: boolean | undefined,
  percentage: number,
  resetTime?: number,
  windowMinutes?: number
): QuotaWindowSnapshot | undefined {
  if (!present) {
    return undefined;
  }

  return {
    slot,
    percentage,
    resetTime,
    windowMinutes
  };
}

function classifyQuotaWindows(windows: QuotaWindowSnapshot[]): {
  hourly?: QuotaWindowSnapshot;
  weekly?: QuotaWindowSnapshot;
} {
  const result: {
    hourly?: QuotaWindowSnapshot;
    weekly?: QuotaWindowSnapshot;
  } = {};

  for (const window of windows) {
    if (isWeeklyWindow(window)) {
      result.weekly = selectPreferredWindow(result.weekly, window, "weekly");
      continue;
    }

    if (isHourlyWindow(window)) {
      result.hourly = selectPreferredWindow(result.hourly, window, "hourly");
    }
  }

  return result;
}

function selectPreferredWindow(
  existing: QuotaWindowSnapshot | undefined,
  candidate: QuotaWindowSnapshot,
  kind: "hourly" | "weekly"
): QuotaWindowSnapshot {
  if (!existing) {
    return candidate;
  }

  const existingMinutes = existing.windowMinutes ?? (kind === "weekly" ? 0 : Number.MAX_SAFE_INTEGER);
  const candidateMinutes = candidate.windowMinutes ?? (kind === "weekly" ? 0 : Number.MAX_SAFE_INTEGER);
  return kind === "weekly"
    ? candidateMinutes >= existingMinutes
      ? candidate
      : existing
    : candidateMinutes <= existingMinutes
      ? candidate
      : existing;
}

function isHourlyWindow(window?: QuotaWindowSnapshot): boolean {
  if (!window) {
    return false;
  }

  const minutes = window.windowMinutes;
  return typeof minutes === "number" && minutes > 0 && minutes <= MAX_HOURLY_WINDOW_MINUTES;
}

function isWeeklyWindow(window?: QuotaWindowSnapshot): boolean {
  if (!window) {
    return false;
  }

  const minutes = window.windowMinutes;
  return typeof minutes === "number" && minutes >= MIN_WEEKLY_WINDOW_MINUTES;
}
