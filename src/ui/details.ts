import * as vscode from "vscode";
import { CodexAccountRecord, CodexDailyUsageBreakdown, CodexDailyUsagePoint, CodexTokens } from "../core/types";
import { runAuthenticatedAccountRequest } from "../application/accounts/authenticatedAccountRequest";
import { resolveAccountHealth, isHealthDismissed } from "../application/accounts/health";
import { formatCreditsText, resolveSubscriptionDisplay } from "../application/dashboard/buildDashboardState";
import { formatAccountPlan, formatAccountStructure, getDashboardCopy } from "../application/dashboard/copy";
import type { DashboardThemeOption } from "../domain/dashboard/types";
import { getCodexAccountsConfiguration, normalizeDashboardTheme } from "../infrastructure/config/extensionSettings";
import type { DashboardLanguage } from "../localization/languages";
import { getIntlLocale } from "../localization/languages";
import { detailCopyResources } from "../localization/resources/details";
import { promptForTags } from "../presentation/tagEditor";
import { getAutoSwitchRuntimeSnapshot } from "../presentation/workbench/autoSwitchState";
import { getTokenAutomationSnapshot } from "../presentation/workbench/tokenAutomationState";
import { fetchDailyUsageBreakdown, fetchProfileLifetimeTokens } from "../services/usage";
import { LocalSessionUsageReader, type LocalSessionUsage } from "../services/localSessionUsage";
import { workspaceKind } from "../services/workspaceIdentity";
import { AccountsRepository } from "../storage";
import {
  colorForPercentage,
  escapeHtml,
  escapeHtmlAttr,
  getLanguage,
  prettyAuthProvider,
  resolveLongQuotaLabel
} from "../utils";
import { formatRelativeReset, formatTimestamp } from "../utils/time";
import { observedQuotaConsumption, quotaWindowReset, QUOTA_HISTORY_DAYS, readQuotaHistory } from "../domain/quotaHistory";

let detailsPanel: vscode.WebviewPanel | undefined;
let detailsPanelRequestId = 0;
let detailsPanelConfigWatcher: vscode.Disposable | undefined;
const localSessionUsageReader = new LocalSessionUsageReader();

type DetailsUsageState = "loading" | "ready" | "empty" | "error";

type DetailsUsage<T> = { state: Exclude<DetailsUsageState, "ready">; value?: undefined } | { state: "ready"; value: T };

type DetailsPanelState = {
  repo?: AccountsRepository;
  accountId?: string;
  styles?: WebviewStyles;
  scripts?: WebviewScripts;
  usageScope?: string;
  dailyUsage: DetailsUsage<CodexDailyUsageBreakdown>;
  lifetimeUsage: DetailsUsage<number>;
  localSessionUsage?: DetailsUsage<LocalSessionUsage>;
  privacyMode: boolean;
};

const detailsPanelState: DetailsPanelState = {
  dailyUsage: { state: "loading" },
  lifetimeUsage: { state: "loading" },
  privacyMode: false
};

export function openDetailsPanel(
  context: vscode.ExtensionContext,
  repo: AccountsRepository,
  account: CodexAccountRecord,
  options?: { privacyMode?: boolean }
): void {
  const copy = getCopy();
  if (!detailsPanel) {
    detailsPanel = vscode.window.createWebviewPanel(
      "codexAccountDetails",
      `${copy.titlePrefix}: ${account.email}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        enableFindWidget: true
      }
    );

    detailsPanel.onDidDispose(() => {
      detailsPanelConfigWatcher?.dispose();
      detailsPanelConfigWatcher = undefined;
      detailsPanelState.repo = undefined;
      detailsPanelState.accountId = undefined;
      detailsPanelState.styles = undefined;
      detailsPanelState.scripts = undefined;
      resetDetailsUsage();
      detailsPanelState.privacyMode = false;
      detailsPanel = undefined;
    });

    detailsPanel.webview.onDidReceiveMessage(async (message: { type?: string }) => {
      if (!detailsPanelState.repo || !detailsPanelState.accountId) {
        return;
      }

      if (message.type === "details:load-local-sessions") {
        if (detailsPanelState.localSessionUsage?.state === "loading") {
          return;
        }
        const requestId = detailsPanelRequestId;
        detailsPanelState.localSessionUsage = { state: "loading" };
        void refreshDetailsPanel();
        try {
          const value = await localSessionUsageReader.read();
          if (isCurrentDetailsRequest(requestId)) {
            detailsPanelState.localSessionUsage = { state: "ready", value };
          }
        } catch {
          if (isCurrentDetailsRequest(requestId)) {
            detailsPanelState.localSessionUsage = { state: "error" };
          }
        }
        if (isCurrentDetailsRequest(requestId)) {
          await refreshDetailsPanel();
        }
        return;
      }

      const current = await detailsPanelState.repo.getAccount(detailsPanelState.accountId);
      if (!current) {
        return;
      }

      if (message.type === "details:edit-tags") {
        const copy = getCopy();
        const dashboardCopy = getDashboardCopy(copy.lang);
        const tags = await promptForTags({
          copy: {
            editTagsBtn: copy.editTagsBtn,
            addTagsBtn: dashboardCopy.addTagsBtn,
            removeTagsBtn: dashboardCopy.removeTagsBtn,
            tagsHelp: copy.tagsHelp,
            tagsPlaceholder: dashboardCopy.tagsPlaceholder,
            tagsRequiredError: dashboardCopy.tagsRequiredError,
            tagsTooManyError: dashboardCopy.tagsTooManyError,
            tagsTooLongError: dashboardCopy.tagsTooLongError
          },
          mode: "set",
          initialTags: current.tags ?? [],
          label: current.email
        });
        if (tags === undefined) {
          return;
        }
        await detailsPanelState.repo.setAccountTags(current.id, tags);
        await refreshDetailsPanel();
        return;
      }

    });

    detailsPanelConfigWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
      if (
          !detailsPanel ||
          (!event.affectsConfiguration("codexAccounts.displayLanguage") &&
          !event.affectsConfiguration("codexAccounts.dashboardTheme") &&
          !event.affectsConfiguration("codexAccounts.quotaGreenThreshold") &&
          !event.affectsConfiguration("codexAccounts.quotaYellowThreshold"))
      ) {
        return;
      }

      void refreshDetailsPanel();
    });
  } else {
    detailsPanel.title = `${copy.titlePrefix}: ${account.email}`;
    detailsPanel.reveal(vscode.ViewColumn.Beside, false);
  }

  const styles = getWebviewStyles(detailsPanel.webview, context.extensionUri, "details.css");
  const scripts = getWebviewScripts(detailsPanel.webview, context.extensionUri, "details.js");
  detailsPanelState.repo = repo;
  detailsPanelState.accountId = account.id;
  detailsPanelState.styles = styles;
  detailsPanelState.scripts = scripts;
  resetDetailsUsage();
  detailsPanelState.privacyMode = options?.privacyMode === true;
  detailsPanelRequestId += 1;
  void refreshDetailsPanel();
}

function resetDetailsUsage(scope?: string): void {
  detailsPanelState.usageScope = scope;
  detailsPanelState.dailyUsage = { state: "loading" };
  detailsPanelState.lifetimeUsage = { state: "loading" };
  detailsPanelState.localSessionUsage = undefined;
}

function hydrateUsage(repo: AccountsRepository, account: CodexAccountRecord, requestId: number): void {
  const initialTokens = repo.getFreshTokens(account.id);
  const load = <T>(fetchUsage: (tokens: CodexTokens) => Promise<T | undefined>) =>
    initialTokens.then((tokens) => {
      if (!isCurrentDetailsRequest(requestId)) {
        return undefined;
      }
      if (!tokens?.accessToken) {
        throw new Error("No access token available");
      }
      return runAuthenticatedAccountRequest(repo, account.id, fetchUsage, tokens);
    });

  const daily = load(async (tokens) => {
    const result = await fetchDailyUsageBreakdown(tokens, 30, account.accountId);
    return result?.points.length ? result : undefined;
  });
  trackDetailsUsage(requestId, daily, (state) => {
    detailsPanelState.dailyUsage = state;
  });
  const lifetime = load((tokens) => fetchProfileLifetimeTokens(tokens, account.accountId));
  trackDetailsUsage(requestId, lifetime, (state) => {
    detailsPanelState.lifetimeUsage = state;
  });
}

function trackDetailsUsage<T>(
  requestId: number,
  request: Promise<T | undefined>,
  save: (usage: DetailsUsage<T>) => void
): void {
  const publish = (usage: DetailsUsage<T>): void => {
    if (isCurrentDetailsRequest(requestId)) {
      save(usage);
      void refreshDetailsPanel();
    }
  };
  void request.then(
    (value) => publish(value === undefined ? { state: "empty" } : { state: "ready", value }),
    () => publish({ state: "error" })
  );
}

function isCurrentDetailsRequest(requestId: number): boolean {
  return detailsPanel !== undefined && detailsPanelRequestId === requestId;
}

export async function refreshDetailsPanel(): Promise<void> {
  if (
    !detailsPanel ||
    !detailsPanelState.repo ||
    !detailsPanelState.accountId ||
    !detailsPanelState.styles ||
    !detailsPanelState.scripts
  ) {
    return;
  }

  const { repo, accountId } = detailsPanelState;
  let requestId = detailsPanelRequestId;
  const account = await repo.getAccount(accountId);
  if (!isCurrentDetailsRequest(requestId)) {
    return;
  }
  if (!account) {
    detailsPanel.dispose();
    return;
  }

  const scope = JSON.stringify([account.accountId, account.organizationId, account.userId]);
  if (scope !== detailsPanelState.usageScope) {
    resetDetailsUsage(scope);
    requestId = ++detailsPanelRequestId;
    hydrateUsage(repo, account, requestId);
  }

  const tokens = await repo.getTokens(account.id);
  if (isCurrentDetailsRequest(requestId)) {
    renderDetails(account, tokens);
  }
}

function renderDetails(account: CodexAccountRecord, tokens?: Awaited<ReturnType<AccountsRepository["getTokens"]>>): void {
  if (!detailsPanel || !detailsPanelState.styles || !detailsPanelState.scripts) {
    return;
  }

  const copy = getCopy();
  const theme = getDetailsThemePreference();
  detailsPanel.title = `${copy.titlePrefix}: ${account.email}`;
  detailsPanel.webview.html = renderHtml(account, tokens, copy, detailsPanelState.styles, detailsPanelState.scripts, {
    theme,
    privacyMode: detailsPanelState.privacyMode,
    dailyUsage: detailsPanelState.dailyUsage,
    lifetimeUsage: detailsPanelState.lifetimeUsage,
    localSessionUsage: detailsPanelState.localSessionUsage
  });
}

type WebviewStyles = {
  shared: string;
  page: string;
};

type WebviewScripts = {
  page: string;
};

type SensitiveKind = "email" | "id" | "name";

function renderHtml(
  account: CodexAccountRecord,
  tokens: Awaited<ReturnType<AccountsRepository["getTokens"]>> | undefined,
  copy: DetailCopy,
  styles: WebviewStyles,
  scripts: WebviewScripts,
  options: {
    theme: DashboardThemeOption;
    privacyMode: boolean;
    dailyUsage: DetailsUsage<CodexDailyUsageBreakdown>;
    lifetimeUsage: DetailsUsage<number>;
    localSessionUsage?: DetailsUsage<LocalSessionUsage>;
  }
): string {
  const quota = account.quotaSummary;
  const accountStatus = account.isActive ? copy.currentlyActive : copy.savedAccount;
  const provider = prettyAuthProvider(account.authProvider);
  const identityName = account.accountName?.trim() ?? account.email;
  const workspaceLabel = formatAccountStructure(account.accountStructure, copy.lang);
  const workspaceValue = getDetailsWorkspaceValue(account, workspaceLabel);
  const dashboardCopy = getDashboardCopy(copy.lang);
  const subscription = resolveSubscriptionDisplay(account, tokens, dashboardCopy, copy.lang);
  const creditsText = formatCreditsText(quota?.credits, copy.lang,
    Boolean(quota) && workspaceKind(account.accountStructure, account.planType) === "workspace");
  const subscriptionStyle = subscription.color ? ` style="color:${escapeHtmlAttr(subscription.color)};"` : "";
  const longQuotaLabel = resolveLongQuotaLabel(
    account.planType,
    quota?.weeklyWindowMinutes,
    copy.lang,
    copy.weeklyQuota,
    "quota"
  );
  const health = resolveAccountHealth(account, tokens, getTokenAutomationSnapshot());
  const dismissedHealth = isHealthDismissed(account, health);
  const autoSwitchRuntime = getAutoSwitchRuntimeSnapshot();
  const autoSwitchLockedUntil =
    autoSwitchRuntime.lockedAccountId === account.id && typeof autoSwitchRuntime.lockedUntil === "number"
      ? autoSwitchRuntime.lockedUntil
      : undefined;
  const quotaCards = [
    ...(quota?.hourlyWindowPresent
      ? [
          `<div class="quota-card">
        <h2>${escapeHtml(copy.hourlyQuota)}</h2>
        <div class="quota-value" style="--metric-color:${colorForPercentage(quota?.hourlyPercentage)};">${renderQuotaValue(quota?.hourlyPercentage)}</div>
        <div class="meta">${escapeHtml(copy.reset)} ${renderLiveReset(quota?.hourlyResetTime, copy)}</div>
      </div>`
        ]
      : []),
    ...(quota?.weeklyWindowPresent
      ? [
          `<div class="quota-card">
        <h2>${escapeHtml(longQuotaLabel)}</h2>
        <div class="quota-value" style="--metric-color:${colorForPercentage(quota?.weeklyPercentage)};">${renderQuotaValue(quota?.weeklyPercentage)}</div>
        <div class="meta">${escapeHtml(copy.reset)} ${renderLiveReset(quota?.weeklyResetTime, copy)}</div>
      </div>`
        ]
      : []),
    ...(quota?.codeReviewWindowPresent
      ? [
          `<div class="quota-card">
        <h2>${escapeHtml(copy.reviewQuota)}</h2>
        <div class="quota-value" style="--metric-color:${colorForPercentage(quota.codeReviewPercentage)};">${renderQuotaValue(quota.codeReviewPercentage)}</div>
        <div class="meta">${escapeHtml(copy.reset)} ${renderLiveReset(quota.codeReviewResetTime, copy)}</div>
      </div>`
        ]
      : []),
    ...(quota?.additionalRateLimits ?? []).flatMap((limit) => {
      const cards: string[] = [];
      if (limit.hourlyWindowPresent) {
        cards.push(`<div class="quota-card">
        <h2>${escapeHtml(`${limit.limitName} ${copy.hourlyQuota}`)}</h2>
        <div class="quota-value" style="--metric-color:${colorForPercentage(limit.hourlyPercentage)};">${renderQuotaValue(limit.hourlyPercentage)}</div>
        <div class="meta">${escapeHtml(copy.reset)} ${renderLiveReset(limit.hourlyResetTime, copy)}</div>
      </div>`);
      }
      if (limit.weeklyWindowPresent) {
        cards.push(`<div class="quota-card">
        <h2>${escapeHtml(`${limit.limitName} ${resolveLongQuotaLabel(undefined, limit.weeklyWindowMinutes, copy.lang, copy.weeklyQuota, "quota")}`)}</h2>
        <div class="quota-value" style="--metric-color:${colorForPercentage(limit.weeklyPercentage)};">${renderQuotaValue(limit.weeklyPercentage)}</div>
        <div class="meta">${escapeHtml(copy.reset)} ${renderLiveReset(limit.weeklyResetTime, copy)}</div>
      </div>`);
      }
      return cards;
    })
  ].join("");

  return `<!DOCTYPE html>
<html lang="${copy.lang}" ${renderDetailsThemeAttributes(options.theme)}>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styles.shared}" />
  <link rel="stylesheet" href="${styles.page}" />
</head>
<body ${renderDetailsBodyAttributes(options.privacyMode)}>
  <div class="shell">
    <section class="panel">
      <div class="panel-inner hero">
        <div class="hero-top">
          <div class="hero-title">
            <div class="hero-title-row">
              <h1>${renderSensitiveHtml(identityName, "name")}</h1>
              <button
                class="privacy-toggle"
                type="button"
                aria-pressed="false"
                aria-label="${escapeHtmlAttr(copy.hideSensitive)}"
                title="${escapeHtmlAttr(copy.hideSensitive)}"
                data-role="privacy-toggle"
                data-show-label="${escapeHtmlAttr(copy.showSensitive)}"
                data-hide-label="${escapeHtmlAttr(copy.hideSensitive)}"
              >
                <span class="privacy-icon privacy-icon-show">${renderEyeSvg()}</span>
                <span class="privacy-icon privacy-icon-hide">${renderEyeOffSvg()}</span>
              </button>
            </div>
            <div class="meta">${renderSensitiveHtml(account.email, "email")}</div>
            <div class="meta">${escapeHtml(copy.detailsSubtitle)}</div>
          </div>
          <div class="badges">
            ${account.isActive ? `<span class="pill active">${escapeHtml(copy.current)}</span>` : `<span class="pill">${escapeHtml(copy.saved)}</span>`}
            <span class="pill plan">${escapeHtml(formatAccountPlan(account, copy.lang))}</span>
            ${renderHealthBadge(health.kind, dismissedHealth, dashboardCopy)}
          </div>
        </div>
        <div class="summary">
          <div class="meta"><strong>${escapeHtml(workspaceLabel)}:</strong> ${renderSensitiveHtml(workspaceValue, "name", "-")}</div>
          <div class="meta"><strong>${escapeHtml(copy.login)}:</strong> ${escapeHtml(provider)}</div>
          <div class="meta"><strong>${escapeHtml(copy.loginTime)}:</strong> ${renderLiveTimestamp(account.loginAt, copy)}</div>
          <div class="meta"><strong>${escapeHtml(copy.subscription)}:</strong> <span${subscriptionStyle} title="${escapeHtmlAttr(subscription.title)}">${escapeHtml(subscription.text)}</span></div>
          ${creditsText ? `<div class="meta">${escapeHtml(creditsText)}</div>` : ""}
          <div class="meta"><strong>${escapeHtml(copy.userId)}:</strong> ${renderSensitiveHtml(account.userId ?? account.accountId, "id", "-")}</div>
          <div class="meta"><strong>${escapeHtml(copy.status)}:</strong> ${escapeHtml(accountStatus)}</div>
        </div>
        <div class="detail-actions">
          <div class="detail-actions-head">${escapeHtml(copy.tagsLabel)}</div>
          <div class="detail-tags-row">
            <div class="detail-tags">${renderTagListHtml(account.tags, copy.noTags)}</div>
            <button class="detail-inline-btn" type="button" data-role="details-edit-tags">${escapeHtml(copy.editTagsBtn)}</button>
          </div>
          ${
            autoSwitchLockedUntil
              ? `<div class="detail-note"><strong>${escapeHtml(copy.autoSwitchLockedUntil)}:</strong> ${renderLiveTimestamp(autoSwitchLockedUntil, copy)}</div>`
              : ""
          }
        </div>
      </div>
    </section>

    <section class="quota-grid">${quotaCards}</section>

    <section class="usage-card">
      <div class="usage-head">
        <div class="usage-title-block">
          <h2>${escapeHtml(copy.usageTitle)}</h2>
          <div class="usage-note">${escapeHtml(copy.usageHint)}</div>
          <div class="meta">${escapeHtml(copy.usageSubtitle)}</div>
        </div>
        <div class="usage-range">${escapeHtml(copy.rangeLabel(options.dailyUsage.value?.days ?? 30))}</div>
      </div>
      <div class="meta">${escapeHtml(copy.usageLifetimeLabel)}: <strong>${escapeHtml(renderLifetimeUsage(options.lifetimeUsage, copy))}</strong></div>
      ${renderUsageSection(options.dailyUsage.state, options.dailyUsage.value, copy)}
    </section>

    ${renderQuotaHistory(account, tokens, copy, longQuotaLabel)}
    ${renderLocalSessionUsage(options.localSessionUsage, copy)}

    <section class="meta-card">
      <h2>${escapeHtml(copy.metadata)}</h2>
      <div class="meta-grid">
        <div class="meta-box">
          <div class="label">${escapeHtml(copy.accountId)}</div>
          <div class="content">${renderSensitiveHtml(account.accountId, "id", "-")}</div>
        </div>
        <div class="meta-box">
          <div class="label">${escapeHtml(copy.organizationId)}</div>
          <div class="content">${renderSensitiveHtml(account.organizationId, "id", "-")}</div>
        </div>
        <div class="meta-box">
          <div class="label">${escapeHtml(copy.lastQuotaRefresh)}</div>
          <div class="content">${renderLiveTimestamp(account.lastQuotaAt, copy)}</div>
        </div>
        <div class="meta-box">
          <div class="label">${escapeHtml(copy.loginTime)}</div>
          <div class="content">${renderLiveTimestamp(account.loginAt, copy)}</div>
        </div>
      </div>
    </section>

  </div>
  <script src="${scripts.page}"></script>
</body>
</html>`;
}

export function getDetailsThemePreference(): DashboardThemeOption {
  return normalizeDashboardTheme(getCodexAccountsConfiguration().get<string>("dashboardTheme", "auto"));
}

export function renderDetailsThemeAttributes(theme: DashboardThemeOption): string {
  return `data-theme="${theme}" data-theme-preference="${theme}"`;
}

export function renderDetailsBodyAttributes(privacyMode: boolean): string {
  const classAttr = privacyMode ? ' class="privacy-hidden"' : "";
  return `${classAttr} data-privacy-hidden="${privacyMode ? "true" : "false"}"`;
}

export function getDetailsWorkspaceValue(account: Pick<CodexAccountRecord, "accountName" | "accountStructure">, fallback: string): string {
  const name = account.accountName?.trim();
  if (name) {
    return name;
  }

  const structure = account.accountStructure?.trim().toLowerCase();
  return !structure || structure === "personal" ? fallback : "";
}

function getWebviewStyles(webview: vscode.Webview, extensionUri: vscode.Uri, pageStylesheet: string): WebviewStyles {
  const shared = vscode.Uri.joinPath(extensionUri, "media", "webview", "shared.css");
  const page = vscode.Uri.joinPath(extensionUri, "media", "webview", pageStylesheet);
  return {
    shared: webview.asWebviewUri(shared).toString(),
    page: webview.asWebviewUri(page).toString()
  };
}

function getWebviewScripts(webview: vscode.Webview, extensionUri: vscode.Uri, pageScript: string): WebviewScripts {
  const page = vscode.Uri.joinPath(extensionUri, "media", "webview", pageScript);
  return {
    page: webview.asWebviewUri(page).toString()
  };
}

function renderLifetimeUsage(usage: DetailsUsage<number>, copy: DetailCopy): string {
  switch (usage.state) {
    case "ready":
      return usage.value.toLocaleString(getIntlLocale(copy.lang));
    case "loading":
      return copy.usageLifetimeLoading;
    case "empty":
      return copy.usageLifetimeEmpty;
    case "error":
      return copy.usageLifetimeError;
  }
}

function renderUsageSection(
  state: "loading" | "ready" | "empty" | "error",
  usage: CodexDailyUsageBreakdown | undefined,
  copy: DetailCopy
): string {
  if (state === "loading") {
    return `<div class="usage-empty">${escapeHtml(copy.usageLoading)}</div>`;
  }

  if (state === "error") {
    return `<div class="usage-empty">${escapeHtml(copy.usageError)}</div>`;
  }

  if (!usage?.points.length) {
    return `<div class="usage-empty">${escapeHtml(copy.usageEmpty)}</div>`;
  }

  const firstPoint = usage.points[0];
  const lastPoint = usage.points[usage.points.length - 1];
  if (!firstPoint || !lastPoint) {
    return `<div class="usage-empty">${escapeHtml(copy.usageEmpty)}</div>`;
  }

  const surfaceKeys = collectVisibleSurfaceKeys(usage.points);
  const max = usage.points.reduce((current, point) => Math.max(current, point.totalTokens), 0) || 1;
  const startLabel = formatUsageDate(firstPoint.date, copy.lang);
  const endLabel = formatUsageDate(lastPoint.date, copy.lang);
  const bars = usage.points
    .map((point, index) => {
      const totalValue = point.totalTokens;
      const height = Math.max(2, Math.round((totalValue / max) * 100));
      const tooltip = escapeHtml(buildUsageTooltip(point, surfaceKeys, copy));
      const edgeClass = index === 0 ? " edge-left" : index === usage.points.length - 1 ? " edge-right" : "";
      const segments = renderUsageSegments(point, surfaceKeys, totalValue, copy);
      return `<div class="usage-bar${totalValue <= 0 ? " is-zero" : ""}${edgeClass}" data-tip="${tooltip}" style="--bar-height:${height}%;">
        <div class="usage-bar-fill" style="height:${height}%;">${segments}</div>
      </div>`;
    })
    .join("");

  const legends = surfaceKeys
    .map(
      (key) =>
        `<span class="usage-legend"><span class="usage-legend-dot" style="--legend-color:${surfaceColor(key)};"></span>${escapeHtml(formatSurfaceLabel(key))}</span>`
    )
    .join("");

  return `<div class="usage-chart">
    <div class="usage-bars">${bars}</div>
    <div class="usage-axis">
      <span>${escapeHtml(startLabel)}</span>
      <span class="usage-legends">${legends}</span>
      <span>${escapeHtml(endLabel)}</span>
    </div>
  </div>`;
}

function renderQuotaValue(value: number | undefined): string {
  return typeof value === "number" ? `${value}%` : "--";
}

function renderLiveReset(epochSeconds: number | undefined, copy: DetailCopy): string {
  if (!epochSeconds) {
    return copy.resetUnknown;
  }

  return `<span class="live-reset" data-reset-at="${epochSeconds}" data-reset-unknown="${escapeHtml(copy.resetUnknown)}">${escapeHtml(formatRelativeReset(epochSeconds))}</span>`;
}

function renderLiveTimestamp(epochMs: number | undefined, copy: DetailCopy): string {
  if (!epochMs) {
    return copy.never;
  }

  return `<span class="live-timestamp" data-epoch-ms="${epochMs}" data-never="${escapeHtml(copy.never)}">${escapeHtml(formatTimestamp(epochMs))}</span>`;
}

function renderSensitiveHtml(value: string | undefined, kind: SensitiveKind, fallback = "—"): string {
  const normalized = value?.trim();
  if (!normalized) {
    return escapeHtml(fallback);
  }

  return `<span class="privacy-sensitive"><span class="privacy-sensitive-raw">${escapeHtml(normalized)}</span><span class="privacy-sensitive-masked">${escapeHtml(maskSensitiveValue(normalized, kind))}</span></span>`;
}

function maskSensitiveValue(value: string, kind: SensitiveKind): string {
  switch (kind) {
    case "email":
      return maskEmail(value);
    case "name":
      return maskSegmentedValue(value);
    case "id":
      return createMask(value.length, 10, 18);
    default:
      return createMask(value.length);
  }
}

function maskEmail(value: string): string {
  const [localPart, domainPart] = value.split("@");
  if (!localPart || !domainPart) {
    return createMask(value.length);
  }

  return `${createMask(localPart.length, 4, 10)}@${createMask(domainPart.length, 4, 10)}`;
}

function maskSegmentedValue(value: string): string {
  return value
    .split(/(\s+|[._\-\\/]+)/)
    .map((segment) => (/^(\s+|[._\-\\/]+)$/.test(segment) ? segment : createMask(segment.length, 3, 8)))
    .join("");
}

function createMask(length: number, min = 6, max = 12): string {
  return "*".repeat(Math.max(min, Math.min(max, Math.max(1, length))));
}

function renderEyeSvg(): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1.5 12s3.8-6 10.5-6 10.5 6 10.5 6-3.8 6-10.5 6S1.5 12 1.5 12Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"></circle></svg>`;
}

function renderEyeOffSvg(): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path><path d="M10.6 5.7A12.6 12.6 0 0 1 12 5.6c6.7 0 10.5 6.4 10.5 6.4a18.4 18.4 0 0 1-4 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path><path d="M6.2 7.2A18.8 18.8 0 0 0 1.5 12s3.8 6 10.5 6c1.6 0 3-.3 4.3-.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path><path d="M9.9 9.8A3.2 3.2 0 0 0 14.2 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
}

function formatUsageDate(input: string, lang: DashboardLanguage): string {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    return input;
  }

  return new Intl.DateTimeFormat(getIntlLocale(lang), { month: "short", day: "numeric" }).format(date);
}

function collectVisibleSurfaceKeys(points: CodexDailyUsagePoint[]): string[] {
  const totals = new Map<string, number>();

  for (const point of points) {
    for (const [key, value] of Object.entries(point.surfaceValues ?? {})) {
      if (value <= 0) {
        continue;
      }
      totals.set(key, (totals.get(key) ?? 0) + value);
    }
  }

  return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
}

function renderUsageSegments(
  point: CodexDailyUsagePoint,
  surfaceKeys: string[],
  totalValue: number,
  copy: DetailCopy
): string {
  if (!surfaceKeys.length || totalValue <= 0) {
    return `<div class="usage-segment usage-segment-empty" style="height:100%;"></div>`;
  }

  const segments = surfaceKeys
    .map((key) => {
      const value = point.surfaceValues?.[key] ?? 0;
      if (value <= 0) {
        return "";
      }

      const ratio = (value / totalValue) * 100;
      return `<div class="usage-segment" title="${escapeHtmlAttr(
        `${formatSurfaceLabel(key)} ${copy.usageValueLabel(value, totalValue)}`
      )}" style="height:${Math.max(2, ratio)}%;--segment-color:${surfaceColor(key)};"></div>`;
    })
    .filter(Boolean)
    .join("");

  return segments || `<div class="usage-segment usage-segment-empty" style="height:100%;"></div>`;
}

function buildUsageTooltip(point: CodexDailyUsagePoint, surfaceKeys: string[], copy: DetailCopy): string {
  const lines = [formatUsageDate(point.date, copy.lang)];
  const totalValue = point.totalTokens;

  for (const key of surfaceKeys) {
    const value = point.surfaceValues?.[key] ?? 0;
    if (value <= 0) {
      continue;
    }
    lines.push(`${formatSurfaceLabel(key)} ${copy.usageValueLabel(value, totalValue)}`);
  }

  if (lines.length === 1) {
    lines.push(copy.usageEmpty);
  }

  return lines.join("\n");
}

function surfaceColor(key: string): string {
  const palette: Record<string, string> = {
    vscode: "#f59e0b",
    web: "#94a3b8",
    github: "#60a5fa",
    github_code_review: "#34d399",
    desktop_app: "#22d3ee",
    exec: "#fbbf24",
    cli: "#fb7185",
    slack: "#f472b6",
    linear: "#a78bfa",
    jetbrains: "#10b981",
    sdk: "#2dd4bf",
    unknown: "#64748b"
  };

  return palette[key] ?? "#64748b";
}

function formatSurfaceLabel(key: string): string {
  return key;
}

function renderQuotaHistory(account: CodexAccountRecord, tokens: CodexTokens | undefined, copy: DetailCopy, longLabel: string): string {
  const now = Date.now();
  const points = readQuotaHistory(account, tokens, now);
  const weekStart = now - 7 * 86400_000;
  const format = new Intl.NumberFormat(getIntlLocale(copy.lang), { maximumFractionDigits: 1 });
  const formatConsumption = (value?: number): string => value === undefined ? "—" : `${format.format(value)} ${copy.quotaHistoryPoints}`;
  const rows = [...points].reverse().map((point, index) => {
    const previous = points[points.length - index - 2];
    const renderWindow = (key: "hourly" | "weekly"): string => {
      const window = point[key];
      if (!window) {
        return '<td><span class="usage-note">—</span></td>';
      }
      const value = format.format(window.remaining);
      const hint = window.resetAt === undefined ? "" :
        `<span class="usage-note">${escapeHtml(copy.reset)} ${escapeHtml(formatTimestamp(window.resetAt))}</span>`;
      const reset = quotaWindowReset(previous?.[key], window)
        ? `<span class="usage-note">${escapeHtml(copy.quotaHistoryReset)}</span>` : "";
      return `<td><span>${escapeHtml(value)}%</span><meter min="0" max="100" value="${window.remaining}" aria-hidden="true"></meter>${reset}${hint}</td>`;
    };
    const at = new Date(point.at);
    return `<tr data-quota-week="${point.at >= weekStart}"${index >= 12 ? " hidden" : ""}><td><time datetime="${at.toISOString()}">${escapeHtml(at.toLocaleString(getIntlLocale(copy.lang)))}</time></td>${renderWindow("hourly")}${renderWindow("weekly")}</tr>`;
  }).join("");
  const totals = (dataset: typeof points, range: number) => `<div class="usage-note" data-quota-totals="${range}"${range === 7 ? " hidden" : ""}>${escapeHtml(copy.quotaHistoryConsumed)} · ${escapeHtml(copy.hourlyQuota)} ${escapeHtml(formatConsumption(observedQuotaConsumption(dataset, "hourly")))} · ${escapeHtml(longLabel)} ${escapeHtml(formatConsumption(observedQuotaConsumption(dataset, "weekly")))}</div>`;
  return `<section class="usage-card quota-history">
    <div class="usage-head"><h2>${escapeHtml(copy.quotaHistoryTitle)}</h2>${rows ? `<div class="detail-history-actions"><button type="button" class="detail-inline-btn" data-quota-range="7" aria-pressed="false">${escapeHtml(copy.rangeLabel(7))}</button><button type="button" class="detail-inline-btn" data-quota-range="30" aria-pressed="true">${escapeHtml(copy.rangeLabel(QUOTA_HISTORY_DAYS))}</button></div>` : ""}</div>
    ${rows ? `${totals(points.filter((point) => point.at >= weekStart), 7)}${totals(points, QUOTA_HISTORY_DAYS)}
    <table><thead><tr><th scope="col">${escapeHtml(copy.quotaHistorySampleTime)}</th><th scope="col">${escapeHtml(copy.hourlyQuota)}</th><th scope="col">${escapeHtml(longLabel)}</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="usage-note" data-quota-empty hidden>${escapeHtml(copy.quotaHistoryEmpty)}</div>
    <div class="detail-history-actions"><button type="button" class="detail-inline-btn" data-quota-previous disabled>${escapeHtml(copy.previousPage)}</button><output data-quota-page aria-live="polite">1 / ${Math.ceil(points.length / 12)}</output><button type="button" class="detail-inline-btn" data-quota-next${points.length <= 12 ? " disabled" : ""}>${escapeHtml(copy.nextPage)}</button></div>`
    : `<div class="usage-note">${escapeHtml(copy.quotaHistoryEmpty)}</div>`}
  </section>`;
}

function renderLocalSessionUsage(usage: DetailsUsage<LocalSessionUsage> | undefined, copy: DetailCopy): string {
  const value = usage?.value;
  return `<section class="usage-card quota-history" data-local-sessions>
    <div class="usage-head"><h2>${escapeHtml(copy.localSessionTitle)}</h2>
      <button class="detail-inline-btn" type="button" data-local-session-load${usage?.state === "loading" ? " disabled" : ""}>${escapeHtml(copy.localSessionLoad)}</button></div>
    <div class="usage-note">${escapeHtml(copy.localSessionHint)}</div>
    ${usage?.state === "loading" ? `<div class="usage-note" role="status">${escapeHtml(copy.usageLoading)}</div>` : ""}
    ${usage?.state === "error" ? `<div class="usage-note" role="alert">${escapeHtml(copy.usageError)}</div>` : ""}
    ${value?.limited ? `<div class="usage-note">${escapeHtml(copy.localSessionLimited)}</div>` : ""}
    ${value?.rows.length ? `<textarea hidden data-local-session-data>${escapeHtml(JSON.stringify(value.rows))}</textarea>
      <div class="detail-history-actions">
        <label>${escapeHtml(copy.localSessionProject)} <select data-local-session-project><option value="*">${escapeHtml(copy.localSessionAll)}</option></select></label>
        <label>${escapeHtml(copy.localSessionModel)} <select data-local-session-model><option value="*">${escapeHtml(copy.localSessionAll)}</option></select></label>
      </div>
      <div class="usage-note" data-local-session-totals aria-live="polite"></div>
      <table><thead><tr><th scope="col">${escapeHtml(copy.quotaHistorySampleTime)}</th><th scope="col">${escapeHtml(copy.localSessionModel)}</th><th scope="col">${escapeHtml(copy.localSessionProject)}</th><th scope="col">${escapeHtml(copy.localSessionTokens)}</th></tr></thead><tbody data-local-session-rows></tbody></table>
      <div class="detail-history-actions"><button type="button" class="detail-inline-btn" data-local-session-previous>${escapeHtml(copy.previousPage)}</button><output data-local-session-page aria-live="polite"></output><button type="button" class="detail-inline-btn" data-local-session-next>${escapeHtml(copy.nextPage)}</button></div>`
      : value ? `<div class="usage-note">${escapeHtml(copy.usageEmpty)}</div>` : ""}
  </section>`;
}

type DetailCopy = {
  lang: DashboardLanguage;
  titlePrefix: string;
  detailsSubtitle: string;
  current: string;
  saved: string;
  disabledTag: string;
  authErrorTag: string;
  quotaErrorTag: string;
  showSensitive: string;
  hideSensitive: string;
  currentlyActive: string;
  savedAccount: string;
  teamName: string;
  login: string;
  loginTime: string;
  subscription: string;
  userId: string;
  status: string;
  hourlyQuota: string;
  weeklyQuota: string;
  reviewQuota: string;
  reset: string;
  usageTitle: string;
  quotaHistoryTitle: string;
  quotaHistoryConsumed: string;
  quotaHistorySampleTime: string;
  quotaHistoryEmpty: string;
  quotaHistoryPoints: string;
  quotaHistoryReset: string;
  previousPage: string;
  nextPage: string;
  localSessionTitle: string;
  localSessionHint: string;
  localSessionLoad: string;
  localSessionLimited: string;
  localSessionProject: string;
  localSessionModel: string;
  localSessionAll: string;
  localSessionTokens: string;
  usageHint: string;
  usageSubtitle: string;
  usageLoading: string;
  usageEmpty: string;
  usageError: string;
  usageLifetimeLabel: string;
  usageLifetimeLoading: string;
  usageLifetimeEmpty: string;
  usageLifetimeError: string;
  rangeLabel: (days: number) => string;
  usageValueLabel: (value: number, total: number) => string;
  metadata: string;
  accountId: string;
  organizationId: string;
  lastQuotaRefresh: string;
  resetUnknown: string;
  never: string;
  tagsLabel: string;
  noTags: string;
  tagsHelp: string;
  editTagsBtn: string;
  lockAutoSwitchBtn: string;
  unlockAutoSwitchBtn: string;
  autoSwitchLockedUntil: string;
};

function getCopy(): DetailCopy {
  const lang = getLanguage();
  const resource = detailCopyResources[lang];
  return {
    lang,
    ...resource,
    rangeLabel: (days) => resource.rangeLabelTemplate.replace("{days}", String(days)),
    usageValueLabel: (value, total) =>
      `${((value / Math.max(total, 1)) * 100).toLocaleString(getIntlLocale(lang), {
        maximumFractionDigits: 0
      })}%`
  };
}

function renderHealthBadge(
  kind: ReturnType<typeof resolveAccountHealth>["kind"],
  dismissed: boolean,
  copy: ReturnType<typeof getDashboardCopy>
): string {
  if (dismissed) {
    return "";
  }

  switch (kind) {
    case "healthy":
      return `<span class="pill ok">${escapeHtml(copy.tokenAutomationHealthy)}</span>`;
    case "expiring":
      return `<span class="pill warning">${escapeHtml(copy.tokenAutomationExpiring)}</span>`;
    case "reauthorize":
      return `<span class="pill error">${escapeHtml(copy.tokenAutomationReauthorize)}</span>`;
    case "refresh_failed":
      return `<span class="pill error">${escapeHtml(copy.tokenAutomationRefreshFailed)}</span>`;
    case "disabled":
      return `<span class="pill error">${escapeHtml(copy.tokenAutomationDisabled)}</span>`;
    case "quota":
      return `<span class="pill warning">${escapeHtml(copy.tokenAutomationQuota)}</span>`;
    default:
      return "";
  }
}

function renderTagListHtml(tags: string[] | undefined, emptyLabel: string): string {
  if (!tags?.length) {
    return `<span class="tag-pill muted">${escapeHtml(emptyLabel)}</span>`;
  }

  const visible = tags.slice(0, 4);
  const remaining = tags.length - visible.length;
  return [
    ...visible.map((tag) => `<span class="tag-pill">${escapeHtml(tag)}</span>`),
    remaining > 0 ? `<span class="tag-pill muted">+${remaining}</span>` : ""
  ]
    .filter(Boolean)
    .join("");
}
