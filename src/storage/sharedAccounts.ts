import { AccountError, ErrorCode } from "../core/errors";
import type { CodexAccountRecord, CodexQuotaSummary, CodexTokens, SharedCodexAccountJson } from "../core/types";
import { buildAccountStorageId } from "../utils/accountIdentity";
import { extractClaims } from "../utils/jwt";

export function toSharedAccountJson(account: CodexAccountRecord, tokens: CodexTokens): SharedCodexAccountJson {
  return {
    id: account.id,
    email: account.email,
    auth_mode: "oauth",
    user_id: account.userId,
    plan_type: account.planType,
    account_id: account.accountId ?? null,
    organization_id: account.organizationId ?? null,
    account_name: account.accountName ?? null,
    account_structure: account.accountStructure ?? null,
    tokens: {
      id_token: tokens.idToken,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      account_id: account.accountId ?? tokens.accountId ?? null
    },
    quota: toSharedQuota(account.quotaSummary),
    quota_error: account.quotaError
      ? {
          code: account.quotaError.code,
          message: account.quotaError.message,
          timestamp: account.quotaError.timestamp
        }
      : null,
    tags: account.tags?.length ? [...account.tags] : null,
    created_at: Math.floor(account.createdAt / 1000),
    last_used: Math.floor(account.updatedAt / 1000)
  };
}

export function previewSharedEntry(entry: SharedCodexAccountJson): { storageId?: string; email?: string } {
  const restoredTokens = restoreSharedTokens(entry);
  const claims = extractClaims(restoredTokens.idToken, restoredTokens.accessToken);
  if (!claims.email) {
    throw new AccountError("Shared account JSON does not include a valid email in tokens", {
      code: ErrorCode.ACCOUNT_INVALID_DATA
    });
  }

  return {
    storageId: buildAccountStorageId(claims.email, claims.accountId, claims.organizationId),
    email: claims.email
  };
}

export function restoreSharedTokens(entry: SharedCodexAccountJson): CodexTokens {
  const idToken = sanitizeOptionalValue(entry.tokens?.id_token);
  const accessToken = sanitizeOptionalValue(entry.tokens?.access_token);
  if (!idToken || !accessToken) {
    throw new AccountError("Shared account JSON does not include valid tokens", {
      code: ErrorCode.AUTH_TOKEN_MISSING
    });
  }

  return {
    idToken,
    accessToken,
    refreshToken: sanitizeOptionalValue(entry.tokens?.refresh_token),
    accountId: sanitizeOptionalValue(entry.tokens?.account_id) ?? sanitizeOptionalValue(entry.account_id)
  };
}

export function normalizeAccountTags(tags: unknown, fallback?: string[] | null | undefined): string[] | undefined {
  const source = Array.isArray(tags) ? tags : Array.isArray(fallback) ? fallback : [];
  const normalized = Array.from(
    new Map(
      source
        .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
        .filter(Boolean)
        .slice(0, 20)
        .map((tag) => [tag.toLowerCase(), tag.slice(0, 24)])
    ).values()
  ).slice(0, 10);

  return normalized.length ? normalized : undefined;
}

export function fromSharedQuota(quota: NonNullable<SharedCodexAccountJson["quota"]>): CodexQuotaSummary {
  return {
    hourlyPercentage: normalizeQuotaNumber(quota.hourly_percentage),
    hourlyResetTime: normalizeOptionalNumber(quota.hourly_reset_time),
    hourlyWindowMinutes: normalizeOptionalNumber(quota.hourly_window_minutes),
    hourlyWindowPresent: Boolean(quota.hourly_window_present),
    weeklyPercentage: normalizeQuotaNumber(quota.weekly_percentage),
    weeklyResetTime: normalizeOptionalNumber(quota.weekly_reset_time),
    weeklyWindowMinutes: normalizeOptionalNumber(quota.weekly_window_minutes),
    weeklyWindowPresent: Boolean(quota.weekly_window_present),
    codeReviewPercentage: normalizeQuotaNumber(quota.code_review_percentage),
    codeReviewResetTime: normalizeOptionalNumber(quota.code_review_reset_time),
    codeReviewWindowMinutes: normalizeOptionalNumber(quota.code_review_window_minutes),
    codeReviewWindowPresent: Boolean(quota.code_review_window_present),
    rawData: quota.raw_data ?? undefined
  };
}

export function fromSharedQuotaError(
  quotaError: SharedCodexAccountJson["quota_error"]
): CodexAccountRecord["quotaError"] | undefined {
  if (!quotaError?.message) {
    return undefined;
  }

  return {
    code: sanitizeOptionalValue(quotaError.code),
    message: quotaError.message,
    timestamp: normalizeEpochSeconds(quotaError.timestamp) ?? Math.floor(Date.now() / 1000)
  };
}

export function sanitizeOptionalValue(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value : value == null ? undefined : String(value);
  const trimmed = normalized?.trim();
  return trimmed ?? undefined;
}

export function normalizeEpochMs(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return value < 1_000_000_000_000 ? value * 1000 : value;
}

export function normalizeEpochSeconds(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return value > 1_000_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
}

function toSharedQuota(summary?: CodexQuotaSummary): SharedCodexAccountJson["quota"] {
  if (!summary) {
    return null;
  }

  return {
    hourly_percentage: summary.hourlyPercentage,
    hourly_reset_time: summary.hourlyResetTime,
    hourly_window_minutes: summary.hourlyWindowMinutes,
    hourly_window_present: summary.hourlyWindowPresent,
    weekly_percentage: summary.weeklyPercentage,
    weekly_reset_time: summary.weeklyResetTime,
    weekly_window_minutes: summary.weeklyWindowMinutes,
    weekly_window_present: summary.weeklyWindowPresent,
    code_review_percentage: summary.codeReviewPercentage,
    code_review_reset_time: summary.codeReviewResetTime,
    code_review_window_minutes: summary.codeReviewWindowMinutes,
    code_review_window_present: summary.codeReviewWindowPresent,
    raw_data: summary.rawData ?? null
  };
}

function normalizeOptionalNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeQuotaNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
