import type { CodexAccountRecord, CodexQuotaHistoryPoint, CodexQuotaHistoryWindow, CodexQuotaSummary, CodexTokens } from "../core/types";
import { workspaceKind } from "../services/workspaceIdentity";
import { extractClaims } from "../utils/jwt";

export const QUOTA_HISTORY_DAYS = 30;
const QUOTA_HISTORY_RETENTION_MS = QUOTA_HISTORY_DAYS * 86400_000;
const MAX_POINTS = 1000;
const RESET_TIME_TOLERANCE_MS = 60_000;

function historyScope(account: CodexAccountRecord, tokens?: CodexTokens): string {
  let claims: ReturnType<typeof extractClaims> | undefined;
  if (tokens) {
    try {
      claims = extractClaims(tokens.idToken, tokens.accessToken);
    } catch {
      // Legacy records can still have a verified saved workspace ID.
    }
  }
  return JSON.stringify([
    account.id, account.accountId ?? tokens?.accountId ?? claims?.accountId,
    account.organizationId ?? claims?.organizationId, account.userId ?? claims?.userId,
    workspaceKind(account.accountStructure, account.planType ?? claims?.planType)
  ]);
}

export function recordQuotaHistory(account: CodexAccountRecord, quota: CodexQuotaSummary, at: number, tokens?: CodexTokens): void {
  if (!Number.isFinite(at) || at <= 0 || at <= (account.quotaHistory?.lastObservedAt ?? 0)) {
    return;
  }
  const scope = historyScope(account, tokens);
  const stored = account.quotaHistory;
  const previous = stored?.scope === scope && Array.isArray(stored.points) ? stored.points : [];
  const points = previous.filter((point) => point.at >= at - QUOTA_HISTORY_RETENTION_MS);
  const hourly = readWindow(quota.hourlyWindowPresent, quota.hourlyPercentage, quota.hourlyResetTime, quota.hourlyWindowMinutes);
  const weekly = readWindow(quota.weeklyWindowPresent, quota.weeklyPercentage, quota.weeklyResetTime, quota.weeklyWindowMinutes);
  const last = points.at(-1);
  if ((!last && (hourly || weekly)) || (last && (changed(last.hourly, hourly) || changed(last.weekly, weekly)))) {
    points.push({ at, hourly, weekly });
  }
  account.quotaHistory = { scope, lastObservedAt: at, points: points.slice(-MAX_POINTS) };
}

export function readQuotaHistory(account: CodexAccountRecord, tokens?: CodexTokens, now = Date.now()): CodexQuotaHistoryPoint[] {
  const stored = account.quotaHistory;
  return stored?.scope === historyScope(account, tokens) && Array.isArray(stored.points)
    ? stored.points.filter((point) => point.at >= now - QUOTA_HISTORY_RETENTION_MS && point.at <= now) : [];
}

export function quotaWindowReset(previous?: CodexQuotaHistoryWindow, current?: CodexQuotaHistoryWindow): boolean {
  return Boolean(previous && current && (
    (previous.resetAt !== undefined && current.resetAt !== undefined && Math.abs(previous.resetAt - current.resetAt) > RESET_TIME_TOLERANCE_MS) ||
    (previous.minutes !== undefined && current.minutes !== undefined && previous.minutes !== current.minutes)
  ));
}

export function observedQuotaConsumption(points: readonly CodexQuotaHistoryPoint[], key: "hourly" | "weekly"): number | undefined {
  let consumed: number | undefined;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]?.[key];
    const current = points[index]?.[key];
    if (previous && current && !quotaWindowReset(previous, current)) {
      consumed = (consumed ?? 0) + Math.max(0, previous.remaining - current.remaining);
    }
  }
  return consumed;
}

function changed(previous?: CodexQuotaHistoryWindow, current?: CodexQuotaHistoryWindow): boolean {
  return previous?.remaining !== current?.remaining || quotaWindowReset(previous, current) ||
    (previous?.resetAt === undefined) !== (current?.resetAt === undefined) ||
    (previous?.minutes === undefined) !== (current?.minutes === undefined);
}

function readWindow(present: boolean | undefined, remaining: number, resetAt?: number, minutes?: number): CodexQuotaHistoryWindow | undefined {
  if (present !== true || !Number.isFinite(remaining) || remaining < 0 || remaining > 100) {
    return undefined;
  }
  return {
    remaining, minutes,
    resetAt: resetAt !== undefined && Number.isFinite(resetAt) && resetAt > 0
      ? resetAt < 100_000_000_000 ? resetAt * 1000 : resetAt : undefined
  };
}
