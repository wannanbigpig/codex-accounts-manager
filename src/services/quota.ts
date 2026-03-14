import { CodexAccountRecord, CodexQuotaErrorInfo, CodexQuotaSummary, CodexTokens, CodexUsageResponse } from "../types";
import { refreshTokens } from "../auth/oauth";
import { extractClaims } from "../utils/jwt";

export interface QuotaRefreshResult {
  quota?: CodexQuotaSummary;
  error?: CodexQuotaErrorInfo;
  updatedTokens?: CodexTokens;
  updatedPlanType?: string;
}

export async function refreshQuota(
  account: CodexAccountRecord,
  tokens: CodexTokens
): Promise<QuotaRefreshResult> {
  let effectiveTokens = tokens;
  if (await shouldRefresh(tokens)) {
    if (!tokens.refreshToken) {
      return { error: buildError("Token expired and no refresh token is available") };
    }
    effectiveTokens = await refreshTokens(tokens.refreshToken);
    effectiveTokens.accountId = effectiveTokens.accountId ?? account.accountId;
  }

  const accountId =
    account.accountId ?? extractClaims(effectiveTokens.idToken, effectiveTokens.accessToken).accountId;

  const headers = new Headers({
    Authorization: `Bearer ${effectiveTokens.accessToken}`,
    Accept: "application/json"
  });
  if (accountId) {
    headers.set("ChatGPT-Account-Id", accountId);
  }

  const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    method: "GET",
    headers
  });

  const raw = await response.text();
  if (!response.ok) {
    return { error: buildError(extractErrorMessage(response.status, raw)), updatedTokens: effectiveTokens };
  }

  const usage = JSON.parse(raw) as CodexUsageResponse;
  return {
    quota: parseUsage(usage, raw),
    updatedTokens: effectiveTokens,
    updatedPlanType: usage.plan_type
  };
}

async function shouldRefresh(tokens: CodexTokens): Promise<boolean> {
  const { needsRefresh } = await import("../auth/oauth");
  return needsRefresh(tokens.accessToken);
}

function parseUsage(usage: CodexUsageResponse, raw: string): CodexQuotaSummary {
  const primary = usage.rate_limit?.primary_window;
  const secondary = usage.rate_limit?.secondary_window;
  const codeReviewPrimary = usage.code_review_rate_limit?.primary_window;

  return {
    hourlyPercentage: normalizeRemaining(primary?.used_percent),
    hourlyResetTime: normalizeReset(primary?.reset_at, primary?.reset_after_seconds),
    hourlyWindowMinutes: normalizeWindow(primary?.limit_window_seconds),
    hourlyWindowPresent: Boolean(primary),
    weeklyPercentage: normalizeRemaining(secondary?.used_percent),
    weeklyResetTime: normalizeReset(secondary?.reset_at, secondary?.reset_after_seconds),
    weeklyWindowMinutes: normalizeWindow(secondary?.limit_window_seconds),
    weeklyWindowPresent: Boolean(secondary),
    codeReviewPercentage: normalizeRemaining(codeReviewPrimary?.used_percent),
    codeReviewResetTime: normalizeReset(codeReviewPrimary?.reset_at, codeReviewPrimary?.reset_after_seconds),
    codeReviewWindowMinutes: normalizeWindow(codeReviewPrimary?.limit_window_seconds),
    codeReviewWindowPresent: Boolean(codeReviewPrimary),
    rawData: JSON.parse(raw) as unknown
  };
}

function normalizeRemaining(usedPercent?: number): number {
  const used = Math.max(0, Math.min(100, usedPercent ?? 0));
  return 100 - used;
}

function normalizeReset(resetAt?: number, resetAfterSeconds?: number): number | undefined {
  if (typeof resetAt === "number") {
    return resetAt;
  }
  if (typeof resetAfterSeconds === "number" && resetAfterSeconds >= 0) {
    return Math.floor(Date.now() / 1000) + resetAfterSeconds;
  }
  return undefined;
}

function normalizeWindow(limitWindowSeconds?: number): number | undefined {
  if (typeof limitWindowSeconds !== "number" || limitWindowSeconds <= 0) {
    return undefined;
  }
  return Math.ceil(limitWindowSeconds / 60);
}

function extractErrorMessage(status: number, raw: string): string {
  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const detail = payload.detail as Record<string, unknown> | undefined;
    const code = typeof detail?.code === "string" ? detail.code : undefined;
    const shortRaw = raw.slice(0, 200);
    return code ? `API returned ${status} [error_code:${code}] - ${shortRaw}` : `API returned ${status} - ${shortRaw}`;
  } catch {
    return `API returned ${status} - ${raw.slice(0, 200)}`;
  }
}

function buildError(message: string): CodexQuotaErrorInfo {
  const codeMatch = message.match(/\[error_code:([^\]]+)\]/);
  return {
    code: codeMatch?.[1],
    message,
    timestamp: Math.floor(Date.now() / 1000)
  };
}
