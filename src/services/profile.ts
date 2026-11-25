/**
 * 账号档案服务模块
 *
 * 优化内容:
 * - 添加更详细的 JSDoc 注释
 * - 改进类型安全性
 * - 使用类型守卫
 * - 复用共享工具函数
 * - 使用统一的错误类型
 */

import { CodexTokens } from "../core/types";
import { extractClaims } from "../utils/jwt";
import { shouldRetryWithoutWorkspace } from "./workspaceRetry";
import { fetchWithTimeout, isRetriableHttpStatus, isRetriableNetworkError, retryWithBackoff } from "../utils/network";
import { APIError } from "../core/errors";
import { logNetworkEvent } from "../utils/debug";
import { ACCOUNT_CHECK_URL } from "../infrastructure/config/apiEndpoints";
import { readAccountCheckString, readWorkspaceString, selectAccountCheckWorkspace } from "./workspaceIdentity";

const PROFILE_CACHE_TTL_MS = 60_000;

type ProfileCacheEntry = {
  profile: RemoteAccountProfile;
  expiresAt: number;
};

const profileCache = new Map<string, ProfileCacheEntry>();

/**
 * 远程账号档案信息
 */
interface RemoteAccountProfile {
  /** 用户邮箱 */
  email?: string;
  /** 用户 ID */
  userId?: string;
  /** 计划类型 */
  planType?: string;
  /** 组织 ID */
  organizationId?: string;
  /** 订阅到期时间 */
  subscriptionActiveUntil?: string;
  /** 账号名称 */
  accountName?: string;
  /** 账号结构类型 */
  accountStructure?: string;
  /** 账号 ID */
  accountId?: string;
}

/**
 * 从远程 API 获取账号档案
 *
 * @param tokens - 认证令牌
 * @returns 账号档案信息，获取失败时返回 undefined
 */
export async function fetchRemoteAccountProfile(
  tokens: CodexTokens,
  options: {
    forceRefresh?: boolean;
    preferredAccountName?: string;
    preferredAccountStructure?: string;
    preferredOrganizationId?: string;
  } = {}
): Promise<RemoteAccountProfile | undefined> {
  const claims = extractClaims(tokens.idToken, tokens.accessToken);
  const accountId = tokens.accountId ?? claims.accountId;
  const organizationId = claims.organizationId ?? options.preferredOrganizationId;
  pruneProfileCache();
  const cacheKey = buildProfileCacheKey(
    tokens.accessToken,
    accountId,
    organizationId,
    options.preferredAccountName,
    options.preferredAccountStructure
  );
  const cached = profileCache.get(cacheKey);
  if (cached && !options.forceRefresh) {
    return cached.profile;
  }

  const primary = await requestAccountProfile(ACCOUNT_CHECK_URL, tokens.accessToken, accountId);
  const workspaceHints = {
    accountId,
    organizationId,
    name: options.preferredAccountName,
    structure: options.preferredAccountStructure
  };
  const profile = primary.ok ? parseAccountProfile(primary.payload, workspaceHints) : undefined;
  let failure = primary.ok ? undefined : primary;
  const shouldRetry =
    accountId &&
    (!primary.ok ? shouldRetryWithoutWorkspace(primary.status, primary.raw) : !profile);

  if (shouldRetry) {
    logNetworkEvent("profile.retry-without-workspace", {
      accountId,
      reason: primary.ok ? "profile_not_matched" : `status_${primary.status}`
    });
    const fallback = await requestAccountProfile(ACCOUNT_CHECK_URL, tokens.accessToken);
    if (fallback.ok) {
      const fallbackProfile = parseAccountProfile(fallback.payload, workspaceHints);
      if (fallbackProfile) {
        profileCache.set(cacheKey, {
          profile: fallbackProfile,
          expiresAt: Date.now() + PROFILE_CACHE_TTL_MS
        });
        return fallbackProfile;
      }
    } else {
      failure ??= fallback;
    }
  }

  if (failure) {
    const reason = failure.status === 401 ? "authorization expired or invalid" :
      failure.status === 403 ? "workspace access denied" : failure.status === 429 ? "rate limited" : "request failed";
    throw new APIError(`Codex account profile ${reason} (HTTP ${failure.status})`, { statusCode: failure.status });
  }

  if (profile) {
    profileCache.set(cacheKey, {
      profile,
      expiresAt: Date.now() + PROFILE_CACHE_TTL_MS
    });
  }
  return profile;
}

async function requestAccountProfile(url: string, accessToken: string, accountId?: string): Promise<{
  ok: boolean;
  status: number;
  raw: string;
  payload: Record<string, unknown>;
}> {
  return retryWithBackoff(
    async () => {
      const headers = new Headers({
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      });

      if (accountId) {
        headers.set("ChatGPT-Account-Id", accountId);
      }

      const response = await fetchWithTimeout(
        url,
        {
          method: "GET",
          headers
        },
        8000,
        "Account profile request"
      );

      const raw = await response.text();
      logNetworkEvent("profile", {
        accountId,
        status: response.status,
        ok: response.ok,
        url,
        bodyPreview: raw
      });

      return {
        ok: response.ok,
        status: response.status,
        raw,
        payload: parseProfilePayload(raw)
      };
    },
    {
      shouldRetryError: isRetriableNetworkError,
      shouldRetryResult: (result) => !result.ok && isRetriableHttpStatus(result.status)
    }
  );
}

function parseProfilePayload(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * 解析账号档案数据
 */
function parseAccountProfile(
  payload: Record<string, unknown>,
  hints: Parameters<typeof selectAccountCheckWorkspace>[1]
): RemoteAccountProfile | undefined {
  const match = selectAccountCheckWorkspace(payload, hints);
  if (!match) {
    return undefined;
  }
  const { workspace } = match;
  const expiryFields = ["subscription_active_until", "subscriptionActiveUntil", "chatgpt_subscription_active_until"];
  return {
    email: readAccountCheckString(payload, ["email"]) ?? readWorkspaceString(workspace, ["email"]),
    userId: readAccountCheckString(payload, ["user_id", "userId"]) ?? readWorkspaceString(workspace, ["user_id", "userId"]),
    planType: readWorkspaceString(workspace, ["plan_type", "planType"]),
    organizationId: workspace.organizationId,
    subscriptionActiveUntil: readScalarField(workspace.account, expiryFields)
      ?? readScalarField(workspace.record, expiryFields),
    accountName: workspace.name,
    accountStructure: workspace.structure,
    accountId: workspace.accountId
  };
}

function readScalarField(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) {
    return undefined;
  }
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

function buildProfileCacheKey(
  accessToken: string,
  accountId?: string,
  organizationId?: string,
  accountName?: string,
  accountStructure?: string
): string {
  return `${accessToken}::${accountId ?? ""}::${organizationId ?? ""}::${accountName ?? ""}::${accountStructure ?? ""}`;
}

function pruneProfileCache(): void {
  const now = Date.now();
  for (const [key, entry] of profileCache.entries()) {
    if (entry.expiresAt <= now) {
      profileCache.delete(key);
    }
  }
}
