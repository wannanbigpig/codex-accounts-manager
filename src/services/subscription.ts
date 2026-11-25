/**
 * 订阅查询服务
 *
 * 对齐 cockpit codex_quota.rs 的 subscription 查询链：
 * 1. GET accounts/check/v4-2023-04-27 → plan_type + expires_at
 * 2. 已确认的工作区优先使用 GET subscriptions?account_id= 的续期明细
 * 3. 失败后 30 分钟回退重试
 */

import type { CodexAccountRecord } from "../core/types";
import { fetchWithTimeout } from "../utils/network";
import { logNetworkEvent } from "../utils/debug";
import { APIError } from "../core/errors";
import { isFreePlanType } from "../utils/quotaLabels";
import { asAccountCheckRecord, readAccountCheckString, readWorkspaceString, selectAccountCheckWorkspace } from "./workspaceIdentity";
import {
  SUBSCRIPTION_ACCOUNTS_CHECK_URL,
  SUBSCRIPTION_RETRY_INTERVAL_SECONDS,
  SUBSCRIPTIONS_URL
} from "../infrastructure/config/apiEndpoints";

/** 订阅状态快照 */
export interface SubscriptionStatusSnapshot {
  source: "subscription" | "entitlement" | "confirmed-free" | "unconfirmed";
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
  if (force) {
    return true;
  }
  if (account.subscriptionQueryNextRetryAt != null && account.subscriptionQueryNextRetryAt > Date.now()) {
    return false;
  }
  if (account.subscriptionQueryLastError) {
    return true;
  }
  if (account.subscriptionExpirySource === "confirmed-free" && isFreePlanType(account.planType)) {
    return false;
  }
  return !account.subscriptionExpirySource || subscriptionMissingOrExpired(account.subscriptionActiveUntil);
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
  const trimmedError = (error ?? "").trim();
  account.subscriptionQueryLastError = trimmedError.length > 0 ? trimmedError : undefined;
}

/**
 * 清除订阅重试状态（对齐 cockpit clear_subscription_retry_pending）
 */
export function clearSubscriptionRetryPending(account: CodexAccountRecord): void {
  account.subscriptionQueryNextRetryAt = undefined;
  account.subscriptionQueryLastError = undefined;
}

/**
 * 先确认工作区，再读取该工作区的订阅明细。
 */
export async function fetchSubscriptionStatus(
  accessToken: string,
  accountId?: string,
  organizationId?: string,
  accountName?: string,
  accountStructure?: string
): Promise<SubscriptionStatusSnapshot> {
  const payload = await fetchAccountCheck(accessToken);
  const match = selectAccountCheckWorkspace(payload, {
    accountId,
    organizationId,
    name: accountName,
    structure: accountStructure
  });
  if (!match) {
    return { source: "unconfirmed", accountId };
  }

  const { workspace, sharedAccountId } = match;
  const effectiveAccountId = workspace.accountId;
  const effectiveOrganizationId = workspace.organizationId ?? organizationId;
  const entitlementExpiry = readSubscriptionExpiry(workspace.entitlement, ["expires_at"])
    ?? readSubscriptionExpiry(workspace.account, ["expires_at"])
    ?? readSubscriptionExpiry(workspace.record, ["expires_at"]);
  const accountPlan = readWorkspaceString(workspace, ["plan_type", "planType"]);
  const entitlementPlan = readAccountCheckString(workspace.entitlement, ["subscription_plan"]);
  const checkPlan = entitlementPlan ?? accountPlan;
  const activeEntitlement = !isFreePlanType(checkPlan) && !subscriptionMissingOrExpired(entitlementExpiry);
  const currentPlan = accountPlan ?? entitlementPlan;
  if (!activeEntitlement && isFreePlanType(currentPlan)) {
    return { source: "confirmed-free", accountId: effectiveAccountId, planType: currentPlan };
  }

  if (effectiveAccountId && (!sharedAccountId || effectiveOrganizationId)) {
    const detail = await fetchSubscriptions(accessToken, effectiveAccountId).catch(() => undefined);
    const sameAccount = !detail?.accountId || detail.accountId === effectiveAccountId;
    const sameOrganization = !effectiveOrganizationId || !detail?.organizationId || detail.organizationId === effectiveOrganizationId;
    // The query contains only an account ID. Shared IDs require the detail to
    // confirm which organization supplied it before it can replace the entitlement.
    const confirmedSharedOrganization = !sharedAccountId || detail?.organizationId === effectiveOrganizationId;
    if (detail?.expiry && sameAccount && sameOrganization && confirmedSharedOrganization) {
      const reportedPlan = activeEntitlement ? checkPlan ?? detail.planType : detail.planType ?? checkPlan;
      const planType = !isFreePlanType(reportedPlan) && !subscriptionMissingOrExpired(detail.expiry) ? reportedPlan : undefined;
      return { source: "subscription", accountId: effectiveAccountId, planType, subscriptionActiveUntil: detail.expiry };
    }
  }

  return activeEntitlement
    ? { source: "entitlement", accountId: effectiveAccountId, planType: checkPlan, subscriptionActiveUntil: entitlementExpiry }
    : { source: "unconfirmed", accountId: effectiveAccountId };
}

// ── 内部实现 ──

function currentTimezoneOffsetMin(): number {
  return -new Date().getTimezoneOffset();
}

function buildSubscriptionHeaders(accessToken: string, targetPath: string): Headers {
  return new Headers({
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    Referer: "https://chatgpt.com/",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    "x-openai-target-path": targetPath,
    "x-openai-target-route": targetPath
  });
}

async function fetchAccountCheck(accessToken: string): Promise<unknown> {
  const url = `${SUBSCRIPTION_ACCOUNTS_CHECK_URL}?timezone_offset_min=${currentTimezoneOffsetMin()}`;
  // accounts/check 需要返回该登录用户的完整 workspace 列表，再在响应中按 accountId 选择。
  // 与 cockpit-tools 保持一致，不在此请求上附加 ChatGPT-Account-Id，避免服务端先错误收窄上下文。
  const headers = buildSubscriptionHeaders(accessToken, "/backend-api/accounts/check/v4-2023-04-27");

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

  return JSON.parse(raw) as unknown;
}

interface SubscriptionDetails {
  accountId?: string;
  organizationId?: string;
  planType?: string;
  expiry?: string;
}

async function fetchSubscriptions(
  accessToken: string,
  accountId: string
): Promise<SubscriptionDetails> {
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

  const payload = asAccountCheckRecord(JSON.parse(raw));
  return {
    accountId: readAccountCheckString(payload, ["account_id", "chatgpt_account_id"]),
    organizationId: readAccountCheckString(payload, ["organization_id", "org_id", "workspace_id"]),
    planType: readAccountCheckString(payload, ["subscription_plan", "plan_type"]),
    expiry: readSubscriptionExpiry(payload, ["active_until", "expires_at"])
  };
}

function readSubscriptionExpiry(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value !== "string" && typeof value !== "number") {
      continue;
    }
    const date = String(value).trim();
    if (parseSubscriptionTimestamp(date) !== undefined) {
      return date;
    }
  }
  return undefined;
}

function parseSubscriptionTimestamp(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  // 纯数字时间戳
  if (/^\d+$/.test(trimmed)) {
    let ts = Number(trimmed);
    if (!Number.isSafeInteger(ts)) {
      return undefined;
    }
    if (ts > 1_000_000_000_000) {
      ts = Math.floor(ts / 1000);
    }
    return ts;
  }
  // ISO 8601
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}
