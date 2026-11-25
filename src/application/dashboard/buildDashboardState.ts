import { DashboardAccountViewModel, DashboardMetricViewModel, DashboardState } from "../../domain/dashboard/types";
import { AccountsRepository } from "../../storage";
import { ExtensionSettingsStore } from "../../infrastructure/config/extensionSettings";
import { formatAccountPlan, formatAccountStructure, formatAuthProvider, getDashboardCopy } from "./copy";
import { CodexAccountRecord, CodexCreditsSummary, CodexTokens, type CodexAnnouncementState } from "../../core/types";
import { resolveCodexAppLaunchPath } from "../../utils/codexApp";
import { getCurrentWindowRuntimeAccountId } from "../../presentation/workbench/windowRuntimeAccount";
import { getQuotaIssueKind } from "../../utils/quotaIssue";
import { getTokenAutomationSnapshot } from "../../presentation/workbench/tokenAutomationState";
import { getAutoSwitchRuntimeSnapshot } from "../../presentation/workbench/autoSwitchState";
import { getAccountAutomationState, isHealthDismissed, resolveAccountHealth } from "../accounts/health";
import { hasPendingResetCreditRedemption } from "../accounts/resetCreditRedemption";
import { isFreePlanType, resolveLongQuotaLabel } from "../../utils/quotaLabels";
import { workspaceKind } from "../../services/workspaceIdentity";

export async function buildDashboardState(
  repo: AccountsRepository,
  settingsStore: ExtensionSettingsStore,
  logoUri: string,
  announcements: CodexAnnouncementState
): Promise<DashboardState> {
  const lang = settingsStore.resolveLanguage();
  const baseSettings = settingsStore.getDashboardSettings();
  const settings = {
    ...baseSettings,
    resolvedCodexAppPath: (await resolveCodexAppLaunchPath(baseSettings.codexAppPath)) ?? ""
  };
  const copy = getDashboardCopy(lang);
  const currentWindowAccountId = getCurrentWindowRuntimeAccountId();
  const tokenAutomation = getTokenAutomationSnapshot();
  const autoSwitchRuntime = getAutoSwitchRuntimeSnapshot();
  const indexHealth = await repo.getIndexHealthSummary();
  const [accounts, accountOrder] = await Promise.all([repo.listAccounts(), repo.getDashboardAccountOrder()]);
  const tokenEntries = await Promise.all(
    accounts.map(async (account) => [account.id, await repo.getTokens(account.id, { syncExternal: false })] as const)
  );
  const tokensByAccountId = new Map(tokenEntries);
  const accountViewStateById = new Map(
    accounts.map((account) => {
      const tokens = tokensByAccountId.get(account.id);
      const health = resolveAccountHealth(account, tokens, tokenAutomation);
      return [
        account.id,
        {
          tokens,
          health,
          dismissedHealth: isHealthDismissed(account, health),
          automationState: getAccountAutomationState(tokenAutomation, account.id),
          healthPriority: getHealthPriority(health)
        }
      ] as const;
    })
  );
  const sortedAccounts = sortDashboardAccounts(accounts, currentWindowAccountId, accountViewStateById, accountOrder);
  const extraSelectedCount = sortedAccounts.filter((account) => !account.isActive && account.showInStatusBar).length;

  return {
    lang,
    panelTitle: copy.panelTitle,
    brandSub: copy.brandSub,
    logoUri,
    settings,
    copy,
    tokenAutomation: {
      enabled: settings.backgroundTokenRefreshEnabled,
      lastCheckAt: tokenAutomation.lastSweepAt,
      nextCheckAt: tokenAutomation.nextSweepAt,
      lastRefreshAt: tokenAutomation.lastSuccessAt,
      lastFailureMessage: tokenAutomation.lastFailureMessage
    },
    announcements,
    indexHealth,
    accounts: sortedAccounts.map((account) =>
      mapAccount(
        account,
        accountViewStateById.get(account.id),
        extraSelectedCount,
        lang,
        copy,
        currentWindowAccountId,
        autoSwitchRuntime
      )
    )
  };
}

export function sortDashboardAccounts<T extends Pick<CodexAccountRecord, "id" | "isActive" | "createdAt" | "email">>(
  accounts: readonly T[],
  currentWindowAccountId?: string,
  accountViewStateById?: Map<string, { healthPriority: number }>,
  order: readonly string[] = []
): T[] {
  const ranks = new Map(order.map((id, index) => [id, index]));
  return [...accounts].sort(
    (a, b) =>
      Number(b.id === currentWindowAccountId) - Number(a.id === currentWindowAccountId) ||
      Number(b.isActive) - Number(a.isActive) ||
      (accountViewStateById?.get(b.id)?.healthPriority ?? 0) -
        (accountViewStateById?.get(a.id)?.healthPriority ?? 0) ||
      (ranks.get(a.id) ?? ranks.size) - (ranks.get(b.id) ?? ranks.size) ||
      b.createdAt - a.createdAt ||
      a.email.localeCompare(b.email)
  );
}

function mapAccount(
  account: CodexAccountRecord,
  viewState:
    | {
        tokens: Awaited<ReturnType<AccountsRepository["getTokens"]>>;
        health: ReturnType<typeof resolveAccountHealth>;
        dismissedHealth: boolean;
        automationState: ReturnType<typeof getAccountAutomationState>;
    }
    | undefined,
  extraSelectedCount: number,
  lang: DashboardState["lang"],
  copy: DashboardState["copy"],
  currentWindowAccountId?: string,
  autoSwitchRuntime?: ReturnType<typeof getAutoSwitchRuntimeSnapshot>
): DashboardAccountViewModel {
  const canToggleStatusBar = account.isActive ? false : Boolean(account.showInStatusBar) || extraSelectedCount < 2;
  const health = viewState?.health ?? resolveAccountHealth(account, viewState?.tokens, getTokenAutomationSnapshot());
  const dismissedHealth = viewState?.dismissedHealth ?? isHealthDismissed(account, health);
  const automationState = viewState?.automationState;
  const subscription = resolveSubscriptionDisplay(account, viewState?.tokens, copy, lang);
  const resetCreditsAvailable = account.quotaSummary?.resetCreditsAvailable ?? account.resetCreditInventory?.snapshot?.availableCount;
  const resetCreditsNextExpiresAt = account.quotaSummary?.resetCreditsNextExpiresAt ?? account.resetCreditInventory?.snapshot?.nextExpiresAt;
  const resetRedemption = hasPendingResetCreditRedemption(account) ? account.resetCreditRedemption : undefined;
  if ((resetCreditsAvailable ?? 0) > 0 && resetCreditsNextExpiresAt == null) {
    console.info("[codexAccounts] dashboard state missing reset credits expiry", {
      accountId: account.id,
      remoteAccountId: account.accountId,
      resetCreditsAvailable,
      lastQuotaAt: account.lastQuotaAt ?? null,
      updatedAt: account.updatedAt
    });
  }

  return {
    quotaIssueKind: getQuotaIssueKind(account.quotaError),
    id: account.id,
    displayName: account.accountName?.trim() ?? account.email,
    email: account.email,
    authMode: account.authMode ?? "chatgpt",
    accountName: account.accountName,
    tags: [...(account.tags ?? [])],
    authProviderLabel: formatAuthProvider(account.authProvider, lang),
    accountStructureLabel: formatAccountStructure(account.accountStructure, lang),
    workspaceLabel: resolveWorkspaceDisplay(account),
    isTeamWorkspace: isTeamWorkspace(account),
    subscriptionText: subscription.text,
    subscriptionTitle: subscription.title,
    subscriptionColor: subscription.color,
    addMethodLabel: `${formatAddMethod(account.addedVia, lang)} | ${formatAuthProvider(account.authProvider, lang)}`,
    addedAtLabel: formatAddedAt(account.createdAt, copy.never),
    statusColor: account.isActive ? "var(--accent-green)" : health.kind === "healthy" ? undefined : "#ef4444",
    planTypeLabel: formatAccountPlan(account, lang),
    creditsText: formatCreditsText(account.quotaSummary?.credits, lang,
      Boolean(account.quotaSummary) && workspaceKind(account.accountStructure, account.planType) === "workspace"),
    userId: account.userId,
    accountId: account.accountId,
    organizationId: account.organizationId,
    isActive: account.isActive,
    isCurrentWindowAccount: account.id === currentWindowAccountId,
    reorderable: !account.isActive && account.id !== currentWindowAccountId && getHealthPriority(health) === 0,
    showInStatusBar: Boolean(account.showInStatusBar),
    canToggleStatusBar,
    statusToggleTitle: canToggleStatusBar
      ? account.showInStatusBar
        ? copy.statusToggleTipChecked
        : copy.statusToggleTip
      : copy.statusLimitTip,
    hasQuota402: hasQuota402(account),
    healthKind: health.kind,
    healthLabel: formatHealthLabel(health.kind, copy),
    healthMessage: health.message,
    healthIssueKey: health.issueKey,
    dismissedHealth,
    lastTokenCheckAt: automationState?.lastCheckAt,
    lastTokenRefreshAt: automationState?.lastRefreshAt,
    lastTokenRefreshError: automationState?.lastError,
    lastQuotaAt: account.lastQuotaAt,
    quotaRefreshFailed: Boolean(account.quotaError),
    quotaHttpStatus: account.quotaError?.statusCode,
    quotaRetryAt: account.quotaError?.statusCode === 429 && Number.isFinite(account.quotaError.retryAt)
      ? account.quotaError.retryAt : undefined,
    resetCreditsAvailable,
    resetCreditsNextExpiresAt,
    resetRedemptionPending: Boolean(resetRedemption),
    resetRedemptionCreditId: resetRedemption?.creditId,
    autoSwitchLockedUntil: autoSwitchRuntime?.lockedAccountId === account.id ? autoSwitchRuntime.lockedUntil : undefined,
    metrics: buildMetrics(account, copy, lang)
  };
}

export function buildMetrics(
  account: CodexAccountRecord,
  copy: DashboardState["copy"],
  lang: DashboardState["lang"]
): DashboardMetricViewModel[] {
  const quota = account.quotaSummary;
  const isFree = isFreePlanType(account.planType);
  const metrics: DashboardMetricViewModel[] = [];

  if (!isFree) {
    metrics.push({
      key: "hourly",
      label: copy.hourlyLabel,
      percentage: quota?.hourlyPercentage,
      resetAt: quota?.hourlyResetTime,
      requestsLeft: quota?.hourlyRequestsLeft,
      requestsLimit: quota?.hourlyRequestsLimit,
      visible: quota ? Boolean(quota.hourlyWindowPresent) : true
    });
  }

  metrics.push({
    key: "weekly",
    label: resolveLongQuotaLabel(account.planType, quota?.weeklyWindowMinutes, lang, copy.weeklyLabel),
    percentage: quota?.weeklyPercentage,
    resetAt: quota?.weeklyResetTime,
    requestsLeft: quota?.weeklyRequestsLeft,
    requestsLimit: quota?.weeklyRequestsLimit,
    visible: quota ? Boolean(quota.weeklyWindowPresent) : true
  });

  if (quota?.codeReviewWindowPresent) {
    metrics.push({
      key: "code-review",
      label: copy.reviewLabel,
      percentage: quota.codeReviewPercentage,
      resetAt: quota.codeReviewResetTime,
      requestsLeft: quota.codeReviewRequestsLeft,
      requestsLimit: quota.codeReviewRequestsLimit,
      visible: true
    });
  }

  for (const [index, limit] of quota?.additionalRateLimits?.entries() ?? []) {
    if (limit.hourlyWindowPresent) {
      metrics.push({
        key: `additional-${index}-hourly`,
        label: `${limit.limitName} ${copy.hourlyLabel}`,
        percentage: limit.hourlyPercentage,
        resetAt: limit.hourlyResetTime,
        requestsLeft: limit.hourlyRequestsLeft,
        requestsLimit: limit.hourlyRequestsLimit,
        visible: true
      });
    }
    if (limit.weeklyWindowPresent) {
      metrics.push({
        key: `additional-${index}-weekly`,
        label: `${limit.limitName} ${resolveLongQuotaLabel(undefined, limit.weeklyWindowMinutes, lang, copy.weeklyLabel)}`,
        percentage: limit.weeklyPercentage,
        resetAt: limit.weeklyResetTime,
        requestsLeft: limit.weeklyRequestsLeft,
        requestsLimit: limit.weeklyRequestsLimit,
        visible: true
      });
    }
  }

  return metrics;
}

function hasQuota402(account: CodexAccountRecord): boolean {
  return getQuotaIssueKind(account.quotaError) === "disabled";
}

function formatHealthLabel(kind: DashboardAccountViewModel["healthKind"], copy: DashboardState["copy"]): string {
  switch (kind) {
    case "expiring":
      return copy.tokenAutomationExpiring;
    case "refresh_failed":
      return copy.tokenAutomationRefreshFailed;
    case "reauthorize":
      return copy.tokenAutomationReauthorize;
    case "disabled":
      return copy.tokenAutomationDisabled;
    case "quota":
      return copy.tokenAutomationQuota;
    default:
      return copy.tokenAutomationHealthy;
  }
}

export function resolveWorkspaceDisplay(account: CodexAccountRecord): string {
  if (!isTeamWorkspace(account)) {
    return "Personal";
  }

  const name = account.accountName?.trim();
  return name ? `Workspace | ${name}` : "Workspace";
}

function isTeamWorkspace(account: CodexAccountRecord): boolean {
  const structure = account.accountStructure?.trim().toLowerCase();
  return Boolean(structure && structure !== "personal");
}

export function resolveSubscriptionDisplay(
  account: CodexAccountRecord,
  tokens: CodexTokens | undefined,
  copy: DashboardState["copy"],
  lang: DashboardState["lang"]
): { text: string; title: string; color?: string } {
  if (account.subscriptionExpirySource === "confirmed-free") {
    return { text: "—", title: copy.subscriptionNoPaidPlan };
  }

  const timestampMs = readSubscriptionTimestampMs(account, tokens);
  const date = timestampMs === undefined ? undefined : new Date(timestampMs);
  if (!date || !Number.isFinite(date.getTime())) {
    return { text: copy.unknown, title: copy.unknown };
  }

  const dateText = formatSubscriptionDate(date);
  if (account.subscriptionQueryLastError) {
    const text = withSubscriptionStatus(dateText, copy.subscriptionExpiryUnconfirmed, lang);
    return { text, title: text };
  }

  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) {
    const text = withSubscriptionStatus(dateText, copy.subscriptionExpired, lang);
    return { text, title: text, color: "#ef4444" };
  }

  const days = Math.ceil(diffMs / 86_400_000);
  const remaining = lang === "zh" || lang === "zh-hant" ? `${days} 天` : `${days}d`;
  const text = withSubscriptionStatus(dateText, remaining, lang);
  const color = diffMs <= 3 * 86_400_000 ? "#ef4444" : diffMs <= 10 * 86_400_000 ? "#f59e0b" : "var(--accent-green)";

  return { text, title: text, color };
}

function withSubscriptionStatus(dateText: string, status: string, lang: DashboardState["lang"]): string {
  return lang === "zh" || lang === "zh-hant" ? `${dateText}（${status}）` : `${dateText} (${status})`;
}

function readSubscriptionTimestampMs(account: CodexAccountRecord, tokens: CodexTokens | undefined): number | undefined {
  const idAuth = getOpenAiAuthClaims(tokens?.idToken);
  const accessAuth = getOpenAiAuthClaims(tokens?.accessToken);
  const raw = normalizeSubscriptionValue(
    account.subscriptionActiveUntil ??
      readWorkspaceSubscriptionClaim(account, idAuth) ??
      readWorkspaceSubscriptionClaim(account, accessAuth)
  );
  if (!raw) {
    return undefined;
  }

  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readWorkspaceSubscriptionClaim(
  account: CodexAccountRecord,
  claims?: Record<string, unknown>
): unknown {
  const accountId = claims?.["chatgpt_account_id"] ?? claims?.["account_id"];
  const organizationId = claims?.["organization_id"] ?? claims?.["chatgpt_organization_id"] ?? claims?.["org_id"];
  if (
    (account.accountId && typeof accountId === "string" && account.accountId !== accountId) ||
    (account.organizationId && typeof organizationId === "string" && account.organizationId !== organizationId)
  ) {
    return undefined;
  }
  return claims?.["chatgpt_subscription_active_until"];
}

export function formatCreditsText(credits: CodexCreditsSummary | undefined, lang: DashboardState["lang"], showUnknown = false): string | undefined {
  if (!credits && !showUnknown) {
    return undefined;
  }

  const copy = lang === "zh"
    ? { label: "剩余积分", limited: "已达限额", unlimited: "无限", available: "可用，余额未公开", unknown: "未知" }
    : lang === "zh-hant"
      ? { label: "剩餘積分", limited: "已達限額", unlimited: "無限", available: "可用，餘額未公開", unknown: "未知" }
      : { label: "Credits left", limited: "Limit reached", unlimited: "Unlimited", available: "Available, balance undisclosed", unknown: "Unknown" };
  const balance = credits?.remaining !== undefined && credits.total !== undefined
    ? `${credits.remaining} / ${credits.total}`
    : credits?.balance.trim();
  let value = balance?.length ? balance : copy.unknown;
  if (credits?.availability === "limited" || (!balance && credits?.overageLimitReached)) {
    value = copy.limited;
  } else if (credits?.unlimited) {
    value = copy.unlimited;
  } else if (credits?.availability === "exhausted" && !balance) {
    value = "0";
  } else if (!balance && credits?.hasCredits) {
    value = copy.available;
  }
  return `${copy.label}: ${value}`;
}

function getOpenAiAuthClaims(token: string | undefined): Record<string, unknown> | undefined {
  const payload = decodeJwtPayload(token);
  const auth = payload?.["https://api.openai.com/auth"];
  return auth && typeof auth === "object" && !Array.isArray(auth) ? (auth as Record<string, unknown>) : undefined;
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  const raw = token?.trim();
  if (!raw) {
    return undefined;
  }

  try {
    const payload = raw.split(".")[1];
    if (!payload) {
      return undefined;
    }
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function normalizeSubscriptionValue(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["value", "timestamp", "ts", "seconds", "sec", "unix", "epoch", "epoch_seconds", "epochSeconds"]) {
      const normalized = normalizeSubscriptionValue(record[key]);
      if (normalized) {
        return normalized;
      }
    }
  }
  return undefined;
}

function formatSubscriptionDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatAddedAt(epochMs: number | undefined, fallback: string): string {
  if (!epochMs) {
    return fallback;
  }

  const date = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatAddMethod(value: string | undefined, lang: DashboardState["lang"]): string {
  const normalized = value?.trim().toLowerCase();
  const zh = lang === "zh" || lang === "zh-hant";
  switch (normalized) {
    case "local":
      return zh ? "本地导入" : "Local import";
    case "json":
      return zh ? "JSON导入" : "JSON import";
    case "oauth":
      return zh ? "OAuth授权" : "OAuth";
    case "token":
      return zh ? "Token导入" : "Token import";
    case "apikey":
      return zh ? "API Key导入" : "API key import";
    default:
      return zh ? "未知来源" : "Unknown source";
  }
}

function getHealthPriority(health: ReturnType<typeof resolveAccountHealth>): number {
  switch (health.kind) {
    case "reauthorize":
      return 5;
    case "disabled":
      return 4;
    case "refresh_failed":
      return 3;
    case "quota":
      return 2;
    case "expiring":
      return 1;
    default:
      return 0;
  }
}
