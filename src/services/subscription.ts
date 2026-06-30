/**
 * 订阅查询服务
 *
 * 对齐 cockpit codex_quota.rs 的 subscription 查询链：
 * 1. GET accounts/check/v4-2023-04-27 → plan_type + expires_at
 * 2. 若 expires_at 缺失/过期 → GET subscriptions?account_id= → 补全
 * 3. 失败后 30 分钟回退重试
 */

import type { CodexAccountRecord } from "../core/types";
import { fetchWithTimeout } from "../utils/network";
import { logNetworkEvent } from "../utils/debug";
import { APIError } from "../core/errors";
import {
  SUBSCRIPTION_ACCOUNTS_CHECK_URL,
  SUBSCRIPTION_RETRY_INTERVAL_SECONDS,
  SUBSCRIPTIONS_URL
} from "../infrastructure/config/apiEndpoints";

/** 订阅状态快照 */
export interface SubscriptionStatusSnapshot {
  accountId?: string;
  planType?: string;
  subscriptionActiveUntil?: string;
}

/**
 * 判断订阅信息是否缺失或已过期
 */
export function subscriptionMissingOrExpired(raw?: string): boolean {
  if (!raw) {
    return true;
  }
  const ts = parseSubscriptionTimestamp(raw);
  return ts == null || ts <= Math.floor(Date.now() / 1000);
}

/**
 * 判断是否应该尝试刷新订阅（对齐 cockpit should_attempt_subscription_refresh）
 */
export function shouldAttemptSubscriptionRefresh(account: CodexAccountRecord, force: boolean): boolean {
  if (!subscriptionMissingOrExpired(account.subscriptionActiveUntil) && !force) {
    return false;
  }
  if (force) {
    return true;
  }
  const now = Date.now();
  return account.subscriptionQueryNextRetryAt == null || account.subscriptionQueryNextRetryAt <= now;
}

/**
 * 标记订阅查询失败，记录回退时间（对齐 cockpit mark_subscription_retry_pending）
 */
export function markSubscriptionRetryPending(
  account: CodexAccountRecord,
  error?: string
): void {
  const now = Date.now();
  account.subscriptionQueryLastAttemptAt = now;
  account.subscriptionQueryNextRetryAt = now + SUBSCRIPTION_RETRY_INTERVAL_SECONDS * 1000;
  account.subscriptionQueryLastError = error?.trim() || undefined;
}

/**
 * 清除订阅重试状态（对齐 cockpit clear_subscription_retry_pending）
 */
export function clearSubscriptionRetryPending(account: CodexAccountRecord): void {
  account.subscriptionQueryNextRetryAt = undefined;
  account.subscriptionQueryLastError = undefined;
}

/**
 * 查询订阅状态：先调 accounts/check，不够再降级到 subscriptions
 */
export async function fetchSubscriptionStatus(
  accessToken: string,
  accountId?: string
): Promise<SubscriptionStatusSnapshot> {
  // 第一步：accounts/check
  const snapshot = await fetchAccountCheck(accessToken, accountId);

  // 第二步：如果 expires_at 缺失/过期，降级到 subscriptions
  if (!subscriptionMissingOrExpired(snapshot.subscriptionActiveUntil)) {
    return snapshot;
  }

  const effectiveAccountId = snapshot.accountId ?? accountId;
  if (!effectiveAccountId) {
    return snapshot;
  }

  try {
    const subscriptions = await fetchSubscriptions(accessToken, effectiveAccountId);
    if (subscriptions.planType) {
      snapshot.planType = subscriptions.planType;
    }
    if (subscriptions.subscriptionActiveUntil) {
      snapshot.subscriptionActiveUntil = subscriptions.subscriptionActiveUntil;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (_error) {
    // subscriptions 失败不抛错，返回 accounts/check 的结果作为兜底
  }

  return snapshot;
}

// ── 内部实现 ──

function currentTimezoneOffsetMin(): number {
  return -new Date().getTimezoneOffset();
}

function buildSubscriptionHeaders(
  accessToken: string,
  targetPath: string,
  accountId?: string
): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    Referer: "https://chatgpt.com/",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    "x-openai-target-path": targetPath,
    "x-openai-target-route": targetPath
  });
  if (accountId) {
    headers.set("ChatGPT-Account-Id", accountId);
  }
  return headers;
}

async function fetchAccountCheck(
  accessToken: string,
  accountId?: string
): Promise<SubscriptionStatusSnapshot> {
  const url = `${SUBSCRIPTION_ACCOUNTS_CHECK_URL}?timezone_offset_min=${currentTimezoneOffsetMin()}`;
  const headers = buildSubscriptionHeaders(accessToken, "/backend-api/accounts/check/v4-2023-04-27", accountId);

  const response = await fetchWithTimeout(url, { method: "GET", headers }, 15000, "Subscription account check");

  const raw = await response.text();
  logNetworkEvent("subscription.check", {
    url: SUBSCRIPTION_ACCOUNTS_CHECK_URL,
    status: response.status,
    ok: response.ok,
    bodyPreview: raw
  });

  if (!response.ok) {
    throw new APIError(`Account check API returned ${response.status}: ${raw.slice(0, 200)}`, {
      statusCode: response.status,
      responseBody: raw.slice(0, 200)
    });
  }

  const payload = JSON.parse(raw) as Record<string, unknown>;
  return parseAccountCheckSnapshot(payload, accountId);
}

async function fetchSubscriptions(
  accessToken: string,
  accountId: string
): Promise<SubscriptionStatusSnapshot> {
  const url = `${SUBSCRIPTIONS_URL}?account_id=${encodeURIComponent(accountId)}`;
  const headers = buildSubscriptionHeaders(accessToken, "/backend-api/subscriptions");

  const response = await fetchWithTimeout(url, { method: "GET", headers }, 15000, "Subscription query");

  const raw = await response.text();
  logNetworkEvent("subscription.detail", {
    url: SUBSCRIPTIONS_URL,
    accountId,
    status: response.status,
    ok: response.ok,
    bodyPreview: raw
  });

  if (!response.ok) {
    throw new APIError(`Subscriptions API returned ${response.status}: ${raw.slice(0, 200)}`, {
      statusCode: response.status,
      responseBody: raw.slice(0, 200)
    });
  }

  const payload = JSON.parse(raw) as Record<string, unknown>;
  return {
    accountId,
    planType: readOptionalScalar(payload, ["subscription_plan", "plan_type"]),
    subscriptionActiveUntil: readOptionalScalar(payload, ["active_until", "expires_at"])
  };
}

// ── accounts/check 响应解析 ──

function parseAccountCheckSnapshot(
  payload: Record<string, unknown>,
  preferredAccountId?: string
): SubscriptionStatusSnapshot {
  const records = collectAccountRecords(payload);
  if (!records.length) {
    return {};
  }

  // 选匹配的 account：优先 preferredAccountId，其次 account_ordering 首个
  const orderingFirstKey =
    (Array.isArray(payload["account_ordering"]) &&
      (payload["account_ordering"] as string[]).find((v) => typeof v === "string" && v.trim())) ||
    undefined;

  const selected =
    records.find((r) => {
      const id = readField(r, ["account_id", "id", "chatgpt_account_id", "workspace_id"]);
      return preferredAccountId && id === preferredAccountId;
    }) ??
    records.find((r) => {
      const key = readField(r, ["key"]);
      return orderingFirstKey && key === orderingFirstKey;
    }) ??
    records[0];

  if (!selected) {
    return {};
  }

  const accountRecord = (selected["account"] as Record<string, unknown> | undefined) ?? selected;
  const entitlement = selected["entitlement"] as Record<string, unknown> | undefined;

  return {
    accountId: readField(accountRecord, ["account_id", "id", "chatgpt_account_id", "workspace_id"]),
    planType:
      (entitlement != null ? readField(entitlement, ["subscription_plan"]) : undefined) ??
      readField(accountRecord, ["plan_type", "planType"]),
    subscriptionActiveUntil:
      (entitlement != null ? readField(entitlement, ["expires_at"]) : undefined) ??
      readField(accountRecord, ["expires_at"])
  };
}

function collectAccountRecords(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const accountsValue = payload["accounts"];
  if (Array.isArray(accountsValue)) {
    return accountsValue.filter(isRecord);
  }
  if (isRecord(accountsValue)) {
    return Object.values(accountsValue).filter(isRecord);
  }
  // 兜底：整个 payload 本身是数组
  if (Array.isArray(payload)) {
    return (payload as unknown[]).filter(isRecord);
  }
  return [];
}

// ── 工具函数 ──

function readField(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readOptionalScalar(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseSubscriptionTimestamp(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  // 纯数字时间戳
  if (/^\d+$/.test(trimmed)) {
    let ts = Number(trimmed);
    if (ts > 1_000_000_000_000) {
      ts = Math.floor(ts / 1000);
    }
    return ts;
  }
  // ISO 8601
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}
