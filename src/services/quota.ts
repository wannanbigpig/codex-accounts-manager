/**
 * 配额服务模块
 *
 * 优化内容:
 * - 使用统一的错误类型
 * - 添加更详细的 JSDoc 注释
 * - 改进类型安全性
 * - 添加配额刷新缓存，避免短时间内重复 API 调用
 */

import { createHash } from "node:crypto";
import {
  CodexAdditionalQuotaLimit,
  CodexAccountRecord,
  CodexQuotaErrorInfo,
  CodexQuotaSummary,
  CodexResetCredit,
  CodexResetCreditsSnapshot,
  CodexTokens,
  CodexUsageResponse,
  UsageRateLimitInfo,
  UsageWindowInfo
} from "../core/types";
import { APIError } from "../core/errors";
import { isAvailableResetCredit } from "../domain/resetCredits";
import { workspaceKind } from "./workspaceIdentity";
import { shouldRetryWithoutWorkspace } from "./workspaceRetry";
import { QUOTA_USAGE_URL, RESET_CREDITS_CONSUME_URL, RESET_CREDITS_URL } from "../infrastructure/config/apiEndpoints";
import { extractClaims } from "../utils/jwt";
import { readUsageCredits } from "../utils/quotaCredits";
import { logNetworkEvent } from "../utils/debug";
import { fetchWithTimeout, isRetriableHttpStatus, isRetriableNetworkError, retryWithBackoff } from "../utils/network";

/** 配额缓存失效时间 (毫秒) - 避免短时间内重复刷新 */
const QUOTA_CACHE_TTL_MS = 30000; // 30 秒
// Bound total inline response backoff to the existing request timeout scale so a batch can continue.
const MAX_QUOTA_INLINE_RETRY_MS = 15_000;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

/** 配额缓存接口 */
interface QuotaCacheEntry {
  requestKey: string;
  scope: QuotaRequestScope;
  /** 缓存的配额摘要 */
  summary: CodexQuotaSummary;
  /** 缓存时间戳 */
  timestamp: number;
}

/** 内存缓存 */
const quotaCache = new Map<string, QuotaCacheEntry>();

/** 同账号并发刷新复用 */
const inflightQuotaRefreshes = new Map<string, { requestKey: string; task: Promise<QuotaRefreshResult> }>();

interface QuotaRequestScope {
  savedAccountId: string;
  accountId?: string;
  organizationId?: string;
  userId?: string;
}

type QuotaCooldownError = CodexQuotaErrorInfo & { retryAt: number };
const quotaCooldowns = new Map<string, { scope: QuotaRequestScope; error: QuotaCooldownError }>();

interface QuotaUsageResult {
  ok: boolean;
  status: number;
  raw: string;
  payload?: CodexUsageResponse;
  cooldownError?: QuotaCooldownError;
  blockedByCooldown?: boolean;
}

export interface QuotaRefreshResult {
  quota?: CodexQuotaSummary;
  /** Observation time for a verified network snapshot. Cache hits do not create another observation. */
  observedAt?: number;
  error?: CodexQuotaErrorInfo;
  updatedTokens?: CodexTokens;
  updatedPlanType?: string;
  updatedSubscriptionActiveUntil?: string;
}

/**
 * 刷新账号配额
 *
 * @param account - 账号记录
 * @param tokens - 认证令牌
 * @param forceRefresh - 是否强制刷新（忽略缓存），默认 false
 * @returns 刷新结果
 */
export async function refreshQuota(
  account: CodexAccountRecord,
  tokens: CodexTokens,
  forceRefresh = false
): Promise<QuotaRefreshResult> {
  pruneQuotaCache();
  let claims: ReturnType<typeof extractClaims> | undefined;
  try {
    claims = extractClaims(tokens.idToken, tokens.accessToken);
  } catch (error) {
    if (!account.accountId && !tokens.accountId) {
      throw error;
    }
  }
  const accountId = account.accountId ?? tokens.accountId ?? claims?.accountId;
  const organizationId = account.organizationId ?? claims?.organizationId;
  const userId = account.userId ?? claims?.userId;
  const scope = { savedAccountId: account.id, accountId, organizationId, userId };
  const savedError = account.quotaError;
  if (savedError?.statusCode === 429 && typeof savedError.retryAt === "number" &&
    Number.isFinite(savedError.retryAt) && savedError.retryAt > Date.now()) {
    invalidateQuotaCacheForScope(scope);
    recordQuotaCooldown(scope, { ...savedError, retryAt: savedError.retryAt });
  }
  const cooldown = getQuotaCooldown(scope);
  const requestKey = createHash("sha256")
    .update(JSON.stringify([accountId, organizationId, userId, account.accountStructure,
      tokens.accountId, tokens.idToken, tokens.accessToken, tokens.refreshToken]))
    .digest("hex");
  if (!forceRefresh && !cooldown) {
    const cached = quotaCache.get(account.id);
    if (cached) {
      if (cached.requestKey === requestKey && Date.now() - cached.timestamp < QUOTA_CACHE_TTL_MS) {
        return { quota: cached.summary };
      }
      quotaCache.delete(account.id);
    }
  }

  const inflight = inflightQuotaRefreshes.get(account.id);
  if (inflight?.requestKey === requestKey) {
    return inflight.task;
  }
  if (cooldown) {
    return { error: cooldown, updatedTokens: tokens };
  }

  const refreshTask = (async (): Promise<QuotaRefreshResult> => {
    const observedAt = Date.now();
    const effectiveTokens = tokens;
    const retryBudget = { remainingMs: MAX_QUOTA_INLINE_RETRY_MS };

    const primary = await requestQuotaUsage(effectiveTokens.accessToken, scope, retryBudget, accountId);
    const unscopedRetry = Boolean(accountId && !primary.ok && primary.status !== 401 &&
      shouldRetryWithoutWorkspace(primary.status, primary.raw));
    if (unscopedRetry) {
      logNetworkEvent("quota.retry-without-workspace", { accountId, status: primary.status });
    }
    const usageResult = unscopedRetry ? await requestQuotaUsage(effectiveTokens.accessToken, scope, retryBudget) : primary;

    if (!usageResult.ok) {
      const { status, raw, cooldownError } = usageResult;
      const error = cooldownError ?? (status >= 200 && status < 300
        ? buildError("Invalid quota response")
        : { ...buildError(extractErrorMessage(status, raw)), statusCode: status });
      return { error, updatedTokens: effectiveTokens };
    }

    const usage = usageResult.payload;
    if (!usage) {
      return { error: buildError("Invalid quota response"), updatedTokens: effectiveTokens };
    }
    const responseAccountId = readOptionalString(usage.account_id, usage.accountId);
    const responseOrganizationId = readOptionalString(usage.organization_id, usage.organizationId);
    const responseUserId = readOptionalString(usage.user_id, usage.userId);
    const knownWorkspaceKind = workspaceKind(account.accountStructure);
    const reportedWorkspaceKind = workspaceKind(undefined, usage.plan_type);
    const unscopedPersonalConflict = unscopedRetry && workspaceKind(account.accountStructure, account.planType) === "personal" &&
      workspaceKind(undefined, usage.plan_type) === "workspace";
    if (
      (accountId && responseAccountId && responseAccountId !== accountId) ||
      (organizationId && responseOrganizationId && responseOrganizationId !== organizationId) ||
      (userId && responseUserId && responseUserId !== userId) ||
      (knownWorkspaceKind && reportedWorkspaceKind && knownWorkspaceKind !== reportedWorkspaceKind) ||
      unscopedPersonalConflict ||
      (unscopedRetry && responseAccountId !== accountId) ||
      ((!accountId || unscopedRetry) && organizationId && responseOrganizationId !== organizationId)
    ) {
      return {
        error: {
          ...buildError("Codex quota response could not be verified for the requested workspace"),
          code: "workspace_identity_mismatch"
        },
        updatedTokens: effectiveTokens
      };
    }
    const quotaSummary = parseUsage(usage, workspaceKind(account.accountStructure, usage.plan_type ?? account.planType) === "workspace");
    if (!quotaSummary) {
      return { error: buildError("Invalid quota response"), updatedTokens: effectiveTokens };
    }
    return {
      quota: quotaSummary,
      observedAt,
      updatedTokens: effectiveTokens,
      updatedPlanType: usage.plan_type,
      updatedSubscriptionActiveUntil: readUsageSubscriptionActiveUntil(usage)
    };
  })();

  inflightQuotaRefreshes.set(account.id, { requestKey, task: refreshTask });
  try {
    const result = await refreshTask;
    if (inflightQuotaRefreshes.get(account.id)?.task === refreshTask) {
      if (result.quota && !getQuotaCooldown(scope)) {
        quotaCache.set(account.id, { requestKey, scope, summary: result.quota, timestamp: Date.now() });
      } else if (quotaCache.get(account.id)?.requestKey === requestKey) {
        quotaCache.delete(account.id);
      }
    }
    return result;
  } finally {
    if (inflightQuotaRefreshes.get(account.id)?.task === refreshTask) {
      inflightQuotaRefreshes.delete(account.id);
    }
  }
}

async function requestQuotaUsage(
  accessToken: string,
  scope: QuotaRequestScope,
  retryBudget: { remainingMs: number },
  accountId?: string
): Promise<QuotaUsageResult> {
  return retryWithBackoff<QuotaUsageResult>(
    async () => {
      // A different credential may have received a 429 while this request was backing off.
      const cooldown = getQuotaCooldown(scope);
      if (cooldown) {
        return { ok: false, status: 429, raw: "", cooldownError: cooldown, blockedByCooldown: true };
      }
      const headers = new Headers({
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      });
      if (accountId) {
        headers.set("ChatGPT-Account-Id", accountId);
      }

      let retryAt: number | undefined;
      const response = await fetchWithTimeout(
        QUOTA_USAGE_URL,
        {
          method: "GET",
          headers
        },
        15000,
        "Quota request",
        {
          onHeaders: ({ status, headers: responseHeaders }) => {
            if (status === 429) {
              invalidateQuotaCacheForScope(scope);
              retryAt = parseRetryAfter(responseHeaders.get("retry-after"), Date.now());
              if (retryAt !== undefined) {
                recordQuotaCooldown(scope, createCooldownError(retryAt, ""));
              }
            }
            return status === 429 || status === 401;
          }
        }
      );

      const raw = await response.text();
      const payload = parseUsagePayload(raw);
      let cooldownError: QuotaCooldownError | undefined;
      if (response.status === 429) {
        invalidateQuotaCacheForScope(scope);
        cooldownError = rememberRetryAfter(scope, retryAt ?? parseRetryAfter(response.headers?.get("retry-after"), Date.now()), raw);
      }
      const requestIds = Object.fromEntries(["request-id", "x-request-id", "cf-ray"].flatMap((name) => {
        const value = response.headers?.get(name);
        return value && /^[a-zA-Z0-9_:-]{1,128}$/.test(value) ? [[name, value]] : [];
      }));
      logNetworkEvent("quota", {
        accountId,
        status: response.status,
        ok: response.ok,
        url: QUOTA_USAGE_URL,
        errorCode: response.ok ? undefined : extractErrorDetailCode(raw),
        ...requestIds,
        retryAt: cooldownError?.retryAt ? new Date(cooldownError.retryAt).toISOString() : undefined,
        bodyPreview: raw
      });
      return {
        ok: response.ok && payload !== undefined,
        status: response.status,
        raw,
        payload,
        cooldownError
      };
    },
    {
      shouldRetryError: isRetriableNetworkError,
      shouldRetryResult: (result) => !result.ok && !result.blockedByCooldown && isRetriableHttpStatus(result.status),
      resultRetryDelayMs: (result, defaultDelayMs) => {
        const retryAt = result.cooldownError?.retryAt;
        const delayMs = retryAt === undefined ? defaultDelayMs : Math.max(defaultDelayMs, retryAt - Date.now());
        if (delayMs > retryBudget.remainingMs) {
          return undefined;
        }
        retryBudget.remainingMs -= delayMs;
        return delayMs;
      }
    }
  );
}

function getQuotaCooldown(scope: QuotaRequestScope): QuotaCooldownError | undefined {
  const now = Date.now();
  let longest: QuotaCooldownError | undefined;
  for (const [key, entry] of quotaCooldowns) {
    if (entry.error.retryAt <= now) {
      quotaCooldowns.delete(key);
      continue;
    }
    if (quotaScopesOverlap(entry.scope, scope) && (!longest || entry.error.retryAt > longest.retryAt)) {
      longest = entry.error;
    }
  }
  return longest;
}

function quotaScopesOverlap(left: QuotaRequestScope, right: QuotaRequestScope): boolean {
  // Filling in previously missing workspace metadata must not bypass a rate limit.
  return left.savedAccountId === right.savedAccountId &&
    (!left.accountId || !right.accountId || left.accountId === right.accountId) &&
    (!left.organizationId || !right.organizationId || left.organizationId === right.organizationId) &&
    (!left.userId || !right.userId || left.userId === right.userId);
}

function invalidateQuotaCacheForScope(scope: QuotaRequestScope): void {
  const cached = quotaCache.get(scope.savedAccountId);
  if (cached && quotaScopesOverlap(cached.scope, scope)) {
    quotaCache.delete(scope.savedAccountId);
  }
}

function rememberRetryAfter(scope: QuotaRequestScope, retryAt: number | undefined, raw: string): QuotaCooldownError | undefined {
  if (retryAt === undefined) {
    return getQuotaCooldown(scope);
  }
  const error = createCooldownError(retryAt, raw);
  recordQuotaCooldown(scope, error, raw.length > 0);
  return getQuotaCooldown(scope) ?? error;
}

function createCooldownError(retryAt: number, raw: string): QuotaCooldownError {
  const message = raw ? extractErrorMessage(429, raw) : "API returned 429";
  return { ...buildError(message), statusCode: 429, retryAt };
}

function recordQuotaCooldown(scope: QuotaRequestScope, error: QuotaCooldownError, hasBody = false): void {
  const key = JSON.stringify([scope.savedAccountId, scope.accountId, scope.organizationId, scope.userId]);
  const savedDeadline = quotaCooldowns.get(key)?.error.retryAt ?? 0;
  if (error.retryAt > Date.now() && (error.retryAt > savedDeadline || (hasBody && error.retryAt === savedDeadline))) {
    quotaCooldowns.set(key, { scope, error });
  }
}

function parseRetryAfter(header: string | null | undefined, now: number): number | undefined {
  const value = header?.trim();
  if (!value) {
    return undefined;
  }
  if (/^\d+$/.test(value)) {
    return Math.min(now + Number(value) * 1_000, MAX_DATE_TIMESTAMP_MS);
  }

  // Date.parse also accepts numbers and locale dates, which are invalid Retry-After values.
  const httpDate = /^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{6,9}, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/;
  if (!httpDate.test(value)) {
    return undefined;
  }
  const date = Date.parse(value.endsWith(" GMT") ? value : `${value} GMT`);
  return Number.isFinite(date) ? Math.max(now, date) : undefined;
}

function parseUsagePayload(raw: string): CodexUsageResponse | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }

    const record = parsed as Record<string, unknown>;
    const hasQuotaData = [
      "rate_limit",
      "code_review_rate_limit",
      "codeReviewRateLimit",
      "code_review",
      "additional_rate_limits",
      "additionalRateLimits",
      "credits",
      "ambient_usage",
      "spend_control",
      "rate_limit_reset_credits",
      "rateLimitResetCredits"
    ].some((key) => record[key] !== undefined && record[key] !== null);
    return hasQuotaData ? record : undefined;
  } catch {
    return undefined;
  }
}

function readUsageSubscriptionActiveUntil(usage: CodexUsageResponse): string | undefined {
  return normalizeOptionalScalar(
    usage.subscription_active_until ?? usage.subscriptionActiveUntil ?? usage.chatgpt_subscription_active_until
  );
}

function normalizeOptionalScalar(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["value", "timestamp", "ts", "seconds", "sec", "unix", "epoch", "epoch_seconds", "epochSeconds"]) {
      const normalized = normalizeOptionalScalar(record[key]);
      if (normalized) {
        return normalized;
      }
    }
  }
  return undefined;
}

/**
 * 解析配额使用量数据
 */
function parseUsage(usage: CodexUsageResponse, workspace: boolean): CodexQuotaSummary | undefined {
  const primary = pickWindow(usage.rate_limit, "primary");
  const secondary = pickWindow(usage.rate_limit, "secondary");
  const additionalRateLimitItems = normalizeAdditionalRateLimitItems(
    usage.additional_rate_limits ?? usage.additionalRateLimits
  );

  // code_review_rate_limit 结构与 rate_limit 一致，兼容顶层、嵌套及驼峰字段。
  const codeReviewRateLimit =
    usage.code_review_rate_limit ??
    usage.codeReviewRateLimit ??
    usage.code_review ??
    usage.rate_limit?.code_review_rate_limit ??
    usage.rate_limit?.codeReviewRateLimit ??
    usage.rate_limit?.code_review;
  const crPrimary = pickWindow(codeReviewRateLimit, "primary");
  const crSecondary = pickWindow(codeReviewRateLimit, "secondary");

  const percentScale = detectUsagePercentScale(primary, secondary);
  const codeReviewPercentScale = detectUsagePercentScale(crPrimary, crSecondary);
  const { hourlyWindow, weeklyWindow } = resolveRateLimitWindows(primary, secondary);
  const hourlyPercentage = resolveRemainingPercentage(hourlyWindow, percentScale);
  const weeklyPercentage = resolveRemainingPercentage(weeklyWindow, percentScale);
  if (invalidQuotaMeasurement(hourlyWindow, hourlyPercentage) || invalidQuotaMeasurement(weeklyWindow, weeklyPercentage)) {
    return undefined;
  }

  const crWindow = extractCodeReviewWindow(crPrimary, crSecondary, codeReviewPercentScale);
  const crPercentage = resolveRemainingPercentage(crWindow, codeReviewPercentScale);
  const additionalRateLimits = parseAdditionalRateLimits(additionalRateLimitItems);
  const credits = readUsageCredits(usage, workspace);
  const resetCreditsAvailable = normalizeResetCreditsAvailable(usage);
  const hasKnownCreditState = credits?.availability === "available" || credits?.availability === "limited" ||
    Boolean(credits?.balance) || credits?.remainingPercent !== undefined;
  if (
    hourlyPercentage === undefined && weeklyPercentage === undefined && crPercentage === undefined &&
    additionalRateLimits.length === 0 && !hasKnownCreditState
  ) {
    return undefined;
  }

  return {
    hourlyPercentage: hourlyPercentage ?? 0,
    hourlyResetTime: normalizeReset(hourlyWindow),
    hourlyRequestsLeft: pickNumberField(hourlyWindow, "remaining", "requests_left", "requestsLeft"),
    hourlyRequestsLimit: pickNumberField(hourlyWindow, "limit", "requests_limit", "requestsLimit"),
    hourlyWindowMinutes: normalizeWindow(hourlyWindow),
    hourlyWindowPresent: hourlyPercentage !== undefined,
    weeklyPercentage: weeklyPercentage ?? 0,
    weeklyResetTime: normalizeReset(weeklyWindow),
    weeklyRequestsLeft: pickNumberField(weeklyWindow, "remaining", "requests_left", "requestsLeft"),
    weeklyRequestsLimit: pickNumberField(weeklyWindow, "limit", "requests_limit", "requestsLimit"),
    weeklyWindowMinutes: normalizeWindow(weeklyWindow),
    weeklyWindowPresent: weeklyPercentage !== undefined,
    codeReviewPercentage: crPercentage ?? 0,
    codeReviewResetTime: crWindow ? normalizeReset(crWindow) : undefined,
    codeReviewRequestsLeft: crWindow ? pickNumberField(crWindow, "remaining", "requests_left", "requestsLeft") : undefined,
    codeReviewRequestsLimit: crWindow ? pickNumberField(crWindow, "limit", "requests_limit", "requestsLimit") : undefined,
    codeReviewWindowMinutes: crWindow ? normalizeWindow(crWindow) : undefined,
    codeReviewWindowPresent: crPercentage !== undefined,
    additionalRateLimits,
    credits,
    resetCreditsAvailable,
    rawData: usage
  };
}

function normalizeResetCreditsAvailable(usage: CodexUsageResponse): number | undefined {
  const src = usage.rate_limit_reset_credits ?? usage.rateLimitResetCredits;
  // 调试日志：确认 API 是否返回了 rate_limit_reset_credits 字段
  logNetworkEvent("quota.resetCredits", {
    hasField: Boolean(src),
    availableCount: src?.available_count ?? src?.availableCount,
    topKeys: Object.keys(usage as Record<string, unknown>).filter(
      (k) => k.toLowerCase().includes("reset") || k.toLowerCase().includes("credit")
    )
  });
  if (!src) {
    return undefined;
  }
  const value = src.available_count ?? src.availableCount;
  return normalizeOptionalInt(value);
}

/**
 * code_review_rate_limit 只有一个窗口（primary_window），兜底取 secondary_window。
 * 与主 rate_limit 不同，这里直接取存在的窗口作为额度窗口。
 */
function extractCodeReviewWindow(
  primary: UsageWindowInfo | undefined,
  secondary: UsageWindowInfo | undefined,
  percentScale: "percent" | "ratio"
): UsageWindowInfo | undefined {
  return (
    [primary, secondary].find((window) => resolveRemainingPercentage(window, percentScale) !== undefined) ??
    primary ??
    secondary
  );
}

type NormalizedAdditionalRateLimit = {
  limitName: string;
  meteredFeature?: string;
  rateLimit: UsageRateLimitInfo;
};

function normalizeAdditionalRateLimitItems(
  items: CodexUsageResponse["additional_rate_limits"]
): NormalizedAdditionalRateLimit[] {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const rateLimit = item.rate_limit ?? item.rateLimit;
    if (!rateLimit || typeof rateLimit !== "object") {
      return [];
    }

    return [
      {
        limitName: readOptionalString(item.limit_name, item.limitName, item.name) ?? "额外模型",
        meteredFeature: readOptionalString(item.metered_feature, item.meteredFeature),
        rateLimit
      }
    ];
  });
}

function parseAdditionalRateLimits(items: NormalizedAdditionalRateLimit[]): CodexAdditionalQuotaLimit[] {
  return items.flatMap((item) => {
    const primary = pickWindow(item.rateLimit, "primary");
    const secondary = pickWindow(item.rateLimit, "secondary");
    const { hourlyWindow, weeklyWindow } = resolveRateLimitWindows(
      primary,
      secondary
    );
    const percentScale = detectUsagePercentScale(primary, secondary);
    const hourlyPercentage = resolveRemainingPercentage(hourlyWindow, percentScale);
    const weeklyPercentage = resolveRemainingPercentage(weeklyWindow, percentScale);

    if (hourlyPercentage === undefined && weeklyPercentage === undefined) {
      return [];
    }

    return [{
      limitName: item.limitName,
      meteredFeature: item.meteredFeature,
      hourlyPercentage,
      hourlyResetTime: normalizeReset(hourlyWindow),
      hourlyRequestsLeft: pickNumberField(hourlyWindow, "remaining", "requests_left", "requestsLeft"),
      hourlyRequestsLimit: pickNumberField(hourlyWindow, "limit", "requests_limit", "requestsLimit"),
      hourlyWindowMinutes: normalizeWindow(hourlyWindow),
      hourlyWindowPresent: hourlyPercentage !== undefined,
      weeklyPercentage,
      weeklyResetTime: normalizeReset(weeklyWindow),
      weeklyRequestsLeft: pickNumberField(weeklyWindow, "remaining", "requests_left", "requestsLeft"),
      weeklyRequestsLimit: pickNumberField(weeklyWindow, "limit", "requests_limit", "requestsLimit"),
      weeklyWindowMinutes: normalizeWindow(weeklyWindow),
      weeklyWindowPresent: weeklyPercentage !== undefined
    }];
  });
}

function resolveRateLimitWindows(
  primary?: CodexUsageResponse["rate_limit"] extends infer R
    ? R extends { primary_window?: infer W }
      ? W
      : never
    : never,
  secondary?: CodexUsageResponse["rate_limit"] extends infer R
    ? R extends { secondary_window?: infer W }
      ? W
      : never
    : never
): {
  hourlyWindow?: typeof primary;
  weeklyWindow?: typeof primary;
} {
  const windows = [primary, secondary].filter((window): window is NonNullable<typeof primary> => Boolean(window));
  if (windows.length === 0) {
    return {};
  }

  if (windows.length === 1) {
    const [onlyWindow] = windows;
    return isWeeklyQuotaWindow(onlyWindow) ? { weeklyWindow: onlyWindow } : { hourlyWindow: onlyWindow };
  }

  const sorted = sortWindowsByDuration(windows);
  return {
    hourlyWindow: sorted[0],
    weeklyWindow: sorted[sorted.length - 1]
  };
}

function isWeeklyQuotaWindow(window: NonNullable<CodexUsageResponse["rate_limit"]>["primary_window"]): boolean {
  const minutes = normalizeWindow(window);
  return typeof minutes === "number" && minutes >= 1440;
}

function getWindowSeconds(window?: UsageWindowInfo): number {
  const seconds = pickNumberField(window, "limit_window_seconds", "limitWindowSeconds");
  return typeof seconds === "number" && seconds > 0 ? seconds : Number.MAX_SAFE_INTEGER;
}

function sortWindowsByDuration(windows: UsageWindowInfo[]): UsageWindowInfo[] {
  return [...windows].sort((left, right) => getWindowSeconds(left) - getWindowSeconds(right));
}

/**
 * 规范化剩余百分比 (转换为 0-100 的范围)
 */
function resolveRemainingPercentage(window: UsageWindowInfo | undefined, scale: "percent" | "ratio"): number | undefined {
  if (!window) {
    return undefined;
  }

  const usedPercent = normalizePercentValue(pickNumberField(window, "used_percent", "usedPercent"), scale);
  if (usedPercent !== undefined) {
    return 100 - usedPercent;
  }

  const remainingPercent = normalizePercentValue(pickNumberField(window, "remaining_percent", "remainingPercent"), scale);
  if (remainingPercent !== undefined) {
    return remainingPercent;
  }

  const remaining = pickNumberField(window, "remaining", "requests_left", "requestsLeft");
  const limit = pickNumberField(window, "limit", "requests_limit", "requestsLimit");
  if (remaining !== undefined && limit !== undefined && limit > 0 && remaining >= 0 && remaining <= limit) {
    return (remaining / limit) * 100;
  }

  return undefined;
}

function normalizePercentValue(value: number | undefined, scale: "percent" | "ratio"): number | undefined {
  const raw = pickNumber(value);
  if (raw === undefined) {
    return undefined;
  }

  const normalized = scale === "ratio" ? raw * 100 : raw;
  return normalized >= 0 && normalized <= 100 ? normalized : undefined;
}

function invalidQuotaMeasurement(window: UsageWindowInfo | undefined, percentage: number | undefined): boolean {
  return Boolean(window && percentage === undefined && (
    [window.used_percent, window.usedPercent, window.remaining_percent, window.remainingPercent].some((value) => value != null) ||
    ([window.remaining, window.requests_left, window.requestsLeft].some((value) => value != null) &&
      [window.limit, window.requests_limit, window.requestsLimit].some((value) => value != null))
  ));
}

function pickNumber(...values: Array<number | undefined>): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function readOptionalString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function pickNumberField<T extends string>(source: Partial<Record<T, number>> | undefined, ...keys: T[]): number | undefined {
  if (!source) {
    return undefined;
  }

  return pickNumber(...keys.map((key) => source[key]));
}

function pickWindow(source: UsageRateLimitInfo | CodexUsageResponse["rate_limit"] | undefined, kind: "primary" | "secondary"): UsageWindowInfo | undefined {
  if (!source) {
    return undefined;
  }

  return kind === "primary"
    ? source.primary_window ?? source.primaryWindow
    : source.secondary_window ?? source.secondaryWindow;
}

function detectUsagePercentScale(...windows: Array<UsageWindowInfo | undefined>): "percent" | "ratio" {
  const values = windows
    .flatMap((window) => [
      pickNumberField(window, "used_percent", "usedPercent"),
      pickNumberField(window, "remaining_percent", "remainingPercent")
    ])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100);

  if (!values.length) {
    return "percent";
  }

  const nonZeroValues = values.filter((value) => value !== 0);
  if (!nonZeroValues.length) {
    return "percent";
  }

  return nonZeroValues.every((value) => value > 0 && value < 1) ? "ratio" : "percent";
}

/**
 * 规范化重置时间
 */
function normalizeReset(window?: UsageWindowInfo): number | undefined {
  const resetAt = pickNumberField(window, "reset_at", "resetAt", "reset_time", "resetTime");
  if (typeof resetAt === "number") {
    return resetAt > 1_000_000_000_000 ? Math.floor(resetAt / 1000) : Math.floor(resetAt);
  }
  const resetAfterSeconds = pickNumberField(window, "reset_after_seconds", "resetAfterSeconds", "reset_after", "resetAfter");
  if (typeof resetAfterSeconds === "number" && resetAfterSeconds >= 0) {
    return Math.floor(Date.now() / 1000) + resetAfterSeconds;
  }
  return undefined;
}

/**
 * 规范化窗口大小 (转换为分钟)
 */
function normalizeWindow(window?: UsageWindowInfo): number | undefined {
  const limitWindowSeconds = pickNumberField(window, "limit_window_seconds", "limitWindowSeconds");
  if (typeof limitWindowSeconds !== "number" || limitWindowSeconds <= 0) {
    return undefined;
  }
  return Math.ceil(limitWindowSeconds / 60);
}

/**
 * 提取错误消息
 */
function extractErrorMessage(status: number, raw: string): string {
  const code = extractErrorDetailCode(raw);
  return `API returned ${status}${code ? ` [error_code:${code}]` : ""} - ${raw.slice(0, 200)}`;
}

/**
 * 构建错误信息对象
 */
function buildError(message: string): CodexQuotaErrorInfo {
  const codeMatch = message.match(/\[error_code:([^\]]+)\]/);
  return {
    code: codeMatch?.[1],
    message,
    timestamp: Math.floor(Date.now() / 1000)
  };
}

function pruneQuotaCache(): void {
  const now = Date.now();
  for (const [key, entry] of quotaCache.entries()) {
    if (now - entry.timestamp >= QUOTA_CACHE_TTL_MS) {
      quotaCache.delete(key);
    }
  }
}

/**
 * 清理指定账号的配额缓存
 *
 * @param accountId - 账号 ID
 */
export function clearQuotaCacheForAccount(accountId: string): void {
  quotaCache.delete(accountId);
  inflightQuotaRefreshes.delete(accountId);
  // Cooldowns belong to the workspace and survive credential or cache changes.
}

// ── 主动重置次数（rate-limit reset credits）──

/**
 * 查询账号的主动重置次数（可用于手动重置 5 小时配额窗口）。
 *
 * @param accessToken - access token
 * @param accountId - ChatGPT account ID
 * @returns 重置次数快照
 */
export async function fetchResetCredits(
  accessToken: string,
  accountId?: string
): Promise<CodexResetCreditsSnapshot> {
  const headers = new Headers({
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json"
  });
  if (accountId) {
    headers.set("ChatGPT-Account-Id", accountId);
  }

  const response = await fetchWithTimeout(
    RESET_CREDITS_URL,
    { method: "GET", headers },
    15000,
    "Reset credits request"
  );

  const raw = await response.text();
  logNetworkEvent("resetCredits", {
    accountId,
    status: response.status,
    ok: response.ok,
    url: RESET_CREDITS_URL,
    bodyPreview: raw
  });

  if (!response.ok) {
    const detailCode = extractErrorDetailCode(raw);
    throw new APIError(`Reset credits API returned ${response.status}: ${raw.slice(0, 200)}`, {
      statusCode: response.status,
      responseBody: raw.slice(0, 200),
      context: detailCode ? { errorCode: detailCode } : undefined
    });
  }

  const payload: unknown = JSON.parse(raw);
  if (!isResetCreditRecord(payload)) {
    throw new Error("Invalid reset credit inventory");
  }
  return parseResetCreditsSnapshot(payload);
}

export type ResetCreditRedemptionOutcome = "reset" | "already_redeemed" | "nothing_to_reset" | "no_credit";

/**
 * 消耗一次主动重置次数。
 *
 * @param accessToken - access token
 * @param accountId - ChatGPT account ID
 */
export async function consumeResetCredit(
  accessToken: string,
  accountId?: string,
  redeemRequestId: string = crypto.randomUUID(),
  creditId?: string
): Promise<ResetCreditRedemptionOutcome> {
  const headers = new Headers({
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json"
  });
  if (accountId) {
    headers.set("ChatGPT-Account-Id", accountId);
  }

  const response = await fetchWithTimeout(
    RESET_CREDITS_CONSUME_URL,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ redeem_request_id: redeemRequestId, credit_id: creditId })
    },
    15000,
    "Consume reset credit"
  );

  const raw = await response.text();
  logNetworkEvent("consumeResetCredit", {
    accountId,
    redeemRequestId,
    status: response.status,
    ok: response.ok,
    url: RESET_CREDITS_CONSUME_URL,
    bodyPreview: raw
  });

  if (!response.ok) {
    const detailCode = extractErrorDetailCode(raw);
    throw new APIError(`Consume reset credit returned ${response.status}: ${raw.slice(0, 200)}`, {
      statusCode: response.status,
      responseBody: raw.slice(0, 200),
      context: detailCode ? { errorCode: detailCode } : undefined
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    // A malformed or empty success response leaves the redemption unconfirmed.
  }

  const code = isResetCreditRecord(payload) ? payload["code"] : undefined;
  switch (code) {
    case "reset":
    case "already_redeemed":
    case "nothing_to_reset":
    case "no_credit":
      return code;
    default:
      throw new APIError(`Reset credit redemption outcome could not be confirmed (HTTP ${response.status})`, {
        statusCode: response.status,
        context: {
          errorCode: "reset_credit_outcome_unconfirmed",
          reason: payload === undefined ? "invalid_or_empty_json" : "missing_or_unknown_code"
        }
      });
  }
}

function parseResetCreditsSnapshot(payload: Record<string, unknown>): CodexResetCreditsSnapshot {
  const dataRecord = isResetCreditRecord(payload["data"]) ? payload["data"] : undefined;
  const creditsValue = payload["credits"] ?? dataRecord?.["credits"];
  const credits: CodexResetCredit[] = Array.isArray(creditsValue)
    ? creditsValue.filter(isResetCreditRecord).map(parseResetCreditRecord)
    : [];

  const reportedCount =
    normalizeOptionalInt(payload["available_count"]) ??
    normalizeOptionalInt(payload["availableCount"]) ??
    normalizeOptionalInt(dataRecord?.["available_count"]) ??
    normalizeOptionalInt(dataRecord?.["availableCount"]);
  if (reportedCount === undefined && (!Array.isArray(creditsValue) || credits.length !== creditsValue.length)) {
    throw new Error("Invalid reset credit inventory");
  }
  const availableCredits = credits.filter((credit) => isAvailableResetCredit(credit));
  const availableCount = reportedCount ?? availableCredits.length;

  const explicitNextExpiresAt =
    readResetCreditTimestamp(payload, [
      "next_expires_at",
      "nextExpiresAt",
      "reset_credits_next_expires_at",
      "resetCreditsNextExpiresAt"
    ]) ??
    (dataRecord
      ? readResetCreditTimestamp(dataRecord, [
          "next_expires_at",
          "nextExpiresAt",
          "reset_credits_next_expires_at",
          "resetCreditsNextExpiresAt"
        ])
      : undefined);

  const derivedNextExpiresAt = availableCredits
    .map((c) => c.expires_at)
    .filter((v): v is number => typeof v === "number" && v > 0)
    .sort((a, b) => a - b)[0];

  const nextExpiresAt = explicitNextExpiresAt ?? derivedNextExpiresAt;

  return { availableCount, credits, nextExpiresAt };
}

function parseResetCreditRecord(record: Record<string, unknown>): CodexResetCredit {
  const rawStatus = readResetCreditString(record, ["status", "state"]);
  const expiresAt = readResetCreditTimestamp(record, ["expires_at", "expire_at", "expiresAt"]);
  return {
    id: readResetCreditString(record, ["id", "credit_id", "creditId"]),
    status: normalizeResetCreditStatus(rawStatus, expiresAt),
    reset_type: readResetCreditString(record, ["type", "reset_type", "resetType"]),
    granted_at: readResetCreditTimestamp(record, ["granted_at", "created_at", "grantedAt"]),
    expires_at: expiresAt,
    redeemed_at: readResetCreditTimestamp(record, ["redeemed_at", "used_at", "consumed_at", "redeemedAt"]),
    raw_status: rawStatus
  };
}

function normalizeResetCreditStatus(rawStatus: string | undefined, expiresAt: number | undefined): string | undefined {
  const status = (rawStatus ?? "available").trim().toLowerCase();
  if (["redeemed", "used", "consumed", "expired"].includes(status)) {
    return status;
  }
  if (typeof expiresAt === "number" && expiresAt <= Math.floor(Date.now() / 1000)) {
    return "expired";
  }
  return status;
}

function readResetCreditString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readResetCreditTimestamp(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value > 1_000_000_000_000 ? Math.floor(value / 1000) : value;
    }
    if (typeof value === "string" && value.trim()) {
      const trimmed = value.trim();
      const numericTimestamp = Number(trimmed);
      if (Number.isFinite(numericTimestamp) && numericTimestamp > 0) {
        return numericTimestamp > 1_000_000_000_000 ? Math.floor(numericTimestamp / 1000) : numericTimestamp;
      }

      const dateTimestamp = Date.parse(trimmed);
      if (Number.isFinite(dateTimestamp) && dateTimestamp > 0) {
        return Math.floor(dateTimestamp / 1000);
      }
    }
  }
  return undefined;
}

function isResetCreditRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeOptionalInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  return undefined;
}

function extractErrorDetailCode(body: string): string | undefined {
  try {
    const value = JSON.parse(body) as Record<string, unknown>;
    const detail = value["detail"];
    const error = value["error"];
    return [
      isResetCreditRecord(detail) ? detail["code"] : undefined,
      isResetCreditRecord(error) ? error["code"] : undefined,
      value["code"]
    ].find((code): code is string => typeof code === "string" && /^[a-zA-Z0-9_:-]{1,128}$/.test(code));
  } catch {
    return undefined;
  }
}
