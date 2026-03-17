import * as vscode from "vscode";
import { AccountsRepository } from "../storage";
import { CodexAccountRecord } from "../core/types";
import { formatRelativeReset, formatTimestamp } from "../utils/time";
import { colorForPercentage, escapeHtml, escapeHtmlAttr, normalizeQuotaColorThresholds } from "../utils";

let quotaSummaryPanel: vscode.WebviewPanel | undefined;
let rerenderQuotaSummaryPanel: (() => Promise<void>) | undefined;
let quotaSummaryConfigWatcher: vscode.Disposable | undefined;

type WebviewStyles = {
  shared: string;
  page: string;
};

type WebviewScripts = {
  page: string;
};

type QuotaSummarySettings = {
  codexAppRestartMode: "auto" | "manual";
  autoRefreshMinutes: number;
  codexAppPath: string;
  showCodeReviewQuota: boolean;
  quotaWarningEnabled: boolean;
  quotaWarningThreshold: number;
  quotaGreenThreshold: number;
  quotaYellowThreshold: number;
  debugNetwork: boolean;
  displayLanguage: "auto" | "zh" | "en";
};

type QuotaSummarySettingsUpdateMessage = {
  type: "settingsUpdated";
  settings: QuotaSummarySettings;
  copy: {
    appPathEmpty: string;
    colorThresholdRedNoteTemplate: string;
    colorThresholdYellowDescTemplate: string;
    colorThresholdGreenDescTemplate: string;
  };
};

type QuotaSummaryContentUpdateMessage = {
  type: "contentUpdated";
  content: {
    primaryHtml: string;
    savedHtml: string;
    showSavedSection: boolean;
  };
};

type QuotaSummaryLanguageUpdateMessage = {
  type: "languageUpdated";
  language: {
    lang: "zh" | "en";
    brandSub: string;
    settingsTitle: string;
    refreshPage: string;
    settingsBodyHtml: string;
  };
  settings: QuotaSummarySettings;
  copy: {
    appPathEmpty: string;
    colorThresholdRedNoteTemplate: string;
    colorThresholdYellowDescTemplate: string;
    colorThresholdGreenDescTemplate: string;
  };
  content: {
    primaryHtml: string;
    savedHtml: string;
    showSavedSection: boolean;
  };
};

export function openQuotaSummaryPanel(context: vscode.ExtensionContext, repo: AccountsRepository): void {
  const lang = resolveLanguage();
  const t = lang === "zh" ? zh : en;
  const iconUri = vscode.Uri.joinPath(context.extensionUri, "media", "CT_logo_transparent_square_hd.png");
  if (!quotaSummaryPanel) {
    quotaSummaryPanel = vscode.window.createWebviewPanel("codexQuotaSummary", t.panelTitle, vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true
    });
    quotaSummaryPanel.iconPath = iconUri;

    quotaSummaryPanel.onDidDispose(() => {
      rerenderQuotaSummaryPanel = undefined;
      quotaSummaryConfigWatcher?.dispose();
      quotaSummaryConfigWatcher = undefined;
      quotaSummaryPanel = undefined;
    });

    quotaSummaryPanel.webview.onDidReceiveMessage(
      async (message: { type?: string; accountId?: string; value?: string | number | boolean }) => {
        let shouldRerender = true;
        const account = message.accountId ? await repo.getAccount(message.accountId) : undefined;

        switch (message.type) {
          case "addAccount":
            await vscode.commands.executeCommand("codexAccounts.addAccount");
            shouldRerender = false;
            break;
          case "importCurrent":
            await vscode.commands.executeCommand("codexAccounts.importCurrentAuth");
            shouldRerender = false;
            break;
          case "refreshAll":
            await vscode.commands.executeCommand("codexAccounts.refreshAllQuotas");
            shouldRerender = false;
            break;
          case "refreshView":
            await refreshInPlace();
            shouldRerender = false;
            break;
          case "details":
            if (account) {
              await vscode.commands.executeCommand("codexAccounts.openDetails", account);
            }
            shouldRerender = false;
            break;
          case "switch":
            if (account) {
              await vscode.commands.executeCommand("codexAccounts.switchAccount", account);
            }
            shouldRerender = false;
            break;
          case "refresh":
            if (account) {
              await vscode.commands.executeCommand("codexAccounts.refreshQuota", account);
            }
            shouldRerender = false;
            break;
          case "remove":
            if (account) {
              await vscode.commands.executeCommand("codexAccounts.removeAccount", account);
            }
            shouldRerender = false;
            break;
          case "toggleStatusBar":
            if (account) {
              await vscode.commands.executeCommand("codexAccounts.toggleStatusBarAccount", account);
            }
            shouldRerender = false;
            break;
          case "updateCodexAppRestartMode":
            if (message.value === "auto" || message.value === "manual") {
              await vscode.workspace
                .getConfiguration("codexAccounts")
                .update("codexAppRestartMode", message.value, vscode.ConfigurationTarget.Global);
            }
            shouldRerender = false;
            break;
          case "updateAutoRefreshMinutes":
            if (typeof message.value === "number") {
              await vscode.workspace
                .getConfiguration("codexAccounts")
                .update("autoRefreshMinutes", message.value, vscode.ConfigurationTarget.Global);
            }
            shouldRerender = false;
            break;
          case "updateShowCodeReviewQuota":
            if (typeof message.value === "boolean") {
              await vscode.workspace
                .getConfiguration("codexAccounts")
                .update("showCodeReviewQuota", message.value, vscode.ConfigurationTarget.Global);
            }
            shouldRerender = false;
            break;
          case "updateQuotaWarningEnabled":
            if (typeof message.value === "boolean") {
              await vscode.workspace
                .getConfiguration("codexAccounts")
                .update("quotaWarningEnabled", message.value, vscode.ConfigurationTarget.Global);
            }
            shouldRerender = false;
            break;
          case "updateQuotaWarningThreshold":
            if (typeof message.value === "number") {
              await vscode.workspace
                .getConfiguration("codexAccounts")
                .update("quotaWarningThreshold", message.value, vscode.ConfigurationTarget.Global);
            }
            shouldRerender = false;
            break;
          case "updateQuotaGreenThreshold":
            if (typeof message.value === "number") {
              await vscode.workspace
                .getConfiguration("codexAccounts")
                .update("quotaGreenThreshold", message.value, vscode.ConfigurationTarget.Global);
            }
            shouldRerender = false;
            break;
          case "updateQuotaYellowThreshold":
            if (typeof message.value === "number") {
              await vscode.workspace
                .getConfiguration("codexAccounts")
                .update("quotaYellowThreshold", message.value, vscode.ConfigurationTarget.Global);
            }
            shouldRerender = false;
            break;
          case "updateDebugNetwork":
            if (typeof message.value === "boolean") {
              await vscode.workspace
                .getConfiguration("codexAccounts")
                .update("debugNetwork", message.value, vscode.ConfigurationTarget.Global);
            }
            shouldRerender = false;
            break;
          case "updateDisplayLanguage":
            if (message.value === "auto" || message.value === "zh" || message.value === "en") {
              await vscode.workspace
                .getConfiguration("codexAccounts")
                .update("displayLanguage", message.value, vscode.ConfigurationTarget.Global);
            }
            shouldRerender = false;
            break;
          case "pickCodexAppPath": {
            const selected = await vscode.window.showOpenDialog({
              canSelectFiles: true,
              canSelectFolders: true,
              canSelectMany: false,
              openLabel: t.pickPath
            });
            if (selected?.[0]) {
              await vscode.workspace
                .getConfiguration("codexAccounts")
                .update("codexAppPath", selected[0].fsPath, vscode.ConfigurationTarget.Global);
            }
            shouldRerender = false;
            break;
          }
          case "clearCodexAppPath":
            await vscode.workspace
              .getConfiguration("codexAccounts")
              .update("codexAppPath", "", vscode.ConfigurationTarget.Global);
            shouldRerender = false;
            break;
          default:
            break;
        }

        if (shouldRerender) {
          await renderFull();
        }
      }
    );

    quotaSummaryConfigWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
      if (!quotaSummaryPanel || !event.affectsConfiguration("codexAccounts")) {
        return;
      }

      if (event.affectsConfiguration("codexAccounts.displayLanguage")) {
        void refreshInPlace();
        return;
      }

      void postSettingsUpdate(quotaSummaryPanel.webview);
    });
  } else {
    quotaSummaryPanel.title = t.panelTitle;
    quotaSummaryPanel.iconPath = iconUri;
    quotaSummaryPanel.reveal(vscode.ViewColumn.Beside, false);
  }

  const panel = quotaSummaryPanel;
  const webviewIconUri = panel.webview.asWebviewUri(iconUri).toString();
  const styles = getWebviewStyles(panel.webview, context.extensionUri, "quotaSummary.css");
  const scripts = getWebviewScripts(panel.webview, context.extensionUri, "quotaSummary.js");

  const renderFull = async (): Promise<void> => {
    const viewData = await buildQuotaSummaryViewData(repo);
    panel.title = getQuotaSummaryCopy().panelTitle;
    panel.webview.html = renderHtml(viewData.accounts, webviewIconUri, styles, scripts, viewData.settings);
  };

  const refreshInPlace = async (): Promise<void> => {
    const viewData = await buildQuotaSummaryViewData(repo);
    panel.title = getQuotaSummaryCopy().panelTitle;
    await postLanguageUpdate(panel.webview, viewData.accounts, viewData.settings);
  };

  const rerender = async (): Promise<void> => {
    const viewData = await buildQuotaSummaryViewData(repo);
    await postContentUpdate(panel.webview, viewData.accounts, viewData.settings);
  };
  rerenderQuotaSummaryPanel = rerender;

  void renderFull();
}

export async function refreshQuotaSummaryPanel(): Promise<void> {
  if (!quotaSummaryPanel || !rerenderQuotaSummaryPanel) {
    return;
  }

  await rerenderQuotaSummaryPanel();
}

function renderHtml(
  accounts: CodexAccountRecord[],
  logoUri: string,
  styles: WebviewStyles,
  scripts: WebviewScripts,
  settings: QuotaSummarySettings
): string {
  const lang = resolveLanguage();
  const t = lang === "zh" ? zh : en;
  const sorted = [...accounts].sort(
    (a, b) => Number(b.isActive) - Number(a.isActive) || a.email.localeCompare(b.email)
  );
  const active = sorted[0];
  const activeLocalized = active ? accountWithTranslations(active, t) : undefined;

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styles.shared}" />
  <link rel="stylesheet" href="${styles.page}" />
</head>
<body>
  <div
    id="quotaSummaryState"
    hidden
    data-codex-app-restart-mode="${escapeHtmlAttr(settings.codexAppRestartMode)}"
    data-auto-refresh-minutes="${settings.autoRefreshMinutes}"
    data-codex-app-path="${escapeHtmlAttr(settings.codexAppPath)}"
    data-show-code-review-quota="${settings.showCodeReviewQuota}"
    data-quota-warning-enabled="${settings.quotaWarningEnabled}"
    data-quota-warning-threshold="${settings.quotaWarningThreshold}"
    data-quota-green-threshold="${settings.quotaGreenThreshold}"
    data-quota-yellow-threshold="${settings.quotaYellowThreshold}"
    data-debug-network="${settings.debugNetwork}"
    data-display-language="${escapeHtmlAttr(settings.displayLanguage)}"
    data-app-path-empty="${escapeHtmlAttr(t.appPathEmpty)}"
    data-threshold-red-note-template="${escapeHtmlAttr(t.colorThresholdRedNoteTemplate)}"
    data-threshold-yellow-desc-template="${escapeHtmlAttr(t.colorThresholdYellowDescTemplate)}"
    data-threshold-green-desc-template="${escapeHtmlAttr(t.colorThresholdGreenDescTemplate)}"
  ></div>
  <div class="panel">
    <section class="section">
      <div class="hero">
        <div class="brand">
          <img class="logo" src="${logoUri}" alt="Codex Tools logo" />
          <div>
            <h1>codex-tools</h1>
            <p id="brandSubText">${escapeHtml(t.brandSub)}</p>
          </div>
        </div>
        <div class="hero-settings">
          <button id="refreshViewButton" class="settings-btn refresh-view-btn" onclick="send('refreshView')" title="${escapeHtmlAttr(t.refreshPage)}" aria-label="${escapeHtmlAttr(t.refreshPage)}">↻</button>
          <button id="settingsOpenButton" class="settings-btn" onclick="openSettings()" title="${escapeHtmlAttr(t.settingsTitle)}" aria-label="${escapeHtmlAttr(t.settingsTitle)}">⚙</button>
        </div>
      </div>
      <div id="primarySectionContent">${renderPrimaryContent(activeLocalized, t, settings)}</div>
    </section>
    <section id="savedAccountsSection" class="section ${sorted.length ? "" : "is-hidden"}">
      <div id="savedAccountsContent">${renderSavedContent(sorted.map((account) => accountWithTranslations(account, t)), t, settings)}</div>
    </section>
  </div>
  <div id="settingsOverlay" class="overlay" onclick="closeSettings(event)">
    <div class="settings-modal" onclick="event.stopPropagation()">
      <div class="settings-modal-head">
        <div id="settingsModalTitle" class="settings-modal-title">${escapeHtml(t.settingsTitle)}</div>
        <button class="settings-close" onclick="closeSettings()">×</button>
      </div>
      <div id="settingsBody" class="settings-modal-body">${renderSettingsBody(t, settings)}</div>
    </div>
  </div>
  <script src="${scripts.page}"></script>
</body>
</html>`;
}

function getWebviewStyles(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  pageStylesheet: string
): WebviewStyles {
  const shared = vscode.Uri.joinPath(extensionUri, "media", "webview", "shared.css");
  const page = vscode.Uri.joinPath(extensionUri, "media", "webview", pageStylesheet);
  return {
    shared: webview.asWebviewUri(shared).toString(),
    page: webview.asWebviewUri(page).toString()
  };
}

function getWebviewScripts(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  pageScript: string
): WebviewScripts {
  const page = vscode.Uri.joinPath(extensionUri, "media", "webview", pageScript);
  return {
    page: webview.asWebviewUri(page).toString()
  };
}

function renderSettingsBody(t: CopySet, settings: QuotaSummarySettings): string {
  return `
    <div class="settings-block">
      <div class="settings-block-head">
        <div class="settings-block-title">${escapeHtml(t.languageTitle)}</div>
        <div class="settings-block-sub">${escapeHtml(t.languageSub)}</div>
      </div>
      <select id="displayLanguageSelect" class="settings-select" onchange="updateDisplayLanguage(this.value)">
        <option value="auto" ${settings.displayLanguage === "auto" ? "selected" : ""}>${escapeHtml(t.languageAuto)}</option>
        <option value="zh" ${settings.displayLanguage === "zh" ? "selected" : ""}>${escapeHtml(t.languageZh)}</option>
        <option value="en" ${settings.displayLanguage === "en" ? "selected" : ""}>${escapeHtml(t.languageEn)}</option>
      </select>
      <div class="settings-note">${escapeHtml(t.languageNote)}</div>
    </div>
    <div class="settings-block">
      <div class="settings-block-head">
        <div class="settings-block-title">${escapeHtml(t.codexAppRestartTitle)}</div>
        <div class="settings-block-sub">${escapeHtml(t.codexAppRestartSub)}</div>
      </div>
      <div class="settings-segment">
        <button id="restartMode-auto" class="segment-btn ${settings.codexAppRestartMode === "auto" ? "active" : ""}" onclick="updateRestartMode('auto')">
          <span class="segment-title">${escapeHtml(t.restartModeAuto)}</span>
          <span class="segment-copy">${escapeHtml(t.restartModeAutoDesc)}</span>
        </button>
        <button id="restartMode-manual" class="segment-btn ${settings.codexAppRestartMode === "manual" ? "active" : ""}" onclick="updateRestartMode('manual')">
          <span class="segment-title">${escapeHtml(t.restartModeManual)}</span>
          <span class="segment-copy">${escapeHtml(t.restartModeManualDesc)}</span>
        </button>
      </div>
      <div class="settings-note">${escapeHtml(t.restartModeNote)}</div>
    </div>
    <div class="settings-block">
      <div class="settings-block-head">
        <div class="settings-block-title">${escapeHtml(t.autoRefreshTitle)}</div>
        <div class="settings-block-sub">${escapeHtml(t.autoRefreshSub)}</div>
      </div>
      <div class="settings-segment">
        <button class="segment-btn ${settings.autoRefreshMinutes > 0 ? "active" : ""}" onclick="toggleAutoRefresh(true)">
          <span class="segment-title">${escapeHtml(t.autoRefreshOn)}</span>
          <span class="segment-copy">${escapeHtml(t.autoRefreshOnDesc)}</span>
        </button>
        <button class="segment-btn ${settings.autoRefreshMinutes === 0 ? "active" : ""}" onclick="toggleAutoRefresh(false)">
          <span class="segment-title">${escapeHtml(t.autoRefreshOff)}</span>
          <span class="segment-copy">${escapeHtml(t.autoRefreshOffDesc)}</span>
        </button>
      </div>
      <div id="autoRefreshValues" class="settings-segment ${settings.autoRefreshMinutes > 0 ? "" : "is-hidden"}">
        ${[5, 10, 15, 30, 60]
          .map(
            (value) => `<button class="segment-btn ${settings.autoRefreshMinutes === value ? "active" : ""}" onclick="updateAutoRefresh(${value})">
          <span class="segment-title">${escapeHtml(t.autoRefreshValue(value))}</span>
          <span class="segment-copy">${escapeHtml(t.autoRefreshValueDesc(value))}</span>
        </button>`
          )
          .join("")}
      </div>
    </div>
    <div class="settings-block">
      <div class="settings-block-head">
        <div class="settings-block-title">${escapeHtml(t.appPathTitle)}</div>
        <div class="settings-block-sub">${escapeHtml(t.appPathSub)}</div>
      </div>
      <div id="codexAppPathNote" class="settings-note" data-empty-text="${escapeHtmlAttr(t.appPathEmpty)}">${escapeHtml(
        settings.codexAppPath || t.appPathEmpty
      )}</div>
      <div class="saved-actions" style="padding:0; border-top:0; justify-content:flex-start;">
        <button onclick="pickCodexAppPath()">${escapeHtml(t.pickPath)}</button>
        <button id="clearCodexAppPathButton" ${settings.codexAppPath ? "" : "disabled"} onclick="clearCodexAppPath()">${escapeHtml(
          t.clearPath
        )}</button>
      </div>
    </div>
    <div class="settings-block">
      <div class="settings-block-head">
        <div class="settings-block-title">${escapeHtml(t.dashboardSettingsTitle)}</div>
        <div class="settings-block-sub">${escapeHtml(t.dashboardSettingsSub)}</div>
      </div>
      <div class="settings-segment">
        <button class="segment-btn ${settings.showCodeReviewQuota ? "active" : ""}" onclick="toggleCodeReview(true)">
          <span class="segment-title">${escapeHtml(t.showReviewOn)}</span>
          <span class="segment-copy">${escapeHtml(t.showReviewOnDesc)}</span>
        </button>
        <button class="segment-btn ${!settings.showCodeReviewQuota ? "active" : ""}" onclick="toggleCodeReview(false)">
          <span class="segment-title">${escapeHtml(t.showReviewOff)}</span>
          <span class="segment-copy">${escapeHtml(t.showReviewOffDesc)}</span>
        </button>
      </div>
    </div>
    <div class="settings-block">
      <div class="settings-block-head">
        <div class="settings-block-title">${escapeHtml(t.warningTitle)}</div>
        <div class="settings-block-sub">${escapeHtml(t.warningSub)}</div>
      </div>
      <div class="settings-segment">
        <button class="segment-btn ${settings.quotaWarningEnabled ? "active" : ""}" onclick="toggleQuotaWarning(true)">
          <span class="segment-title">${escapeHtml(t.warningOn)}</span>
          <span class="segment-copy">${escapeHtml(t.warningOnDesc)}</span>
        </button>
        <button class="segment-btn ${!settings.quotaWarningEnabled ? "active" : ""}" onclick="toggleQuotaWarning(false)">
          <span class="segment-title">${escapeHtml(t.warningOff)}</span>
          <span class="segment-copy">${escapeHtml(t.warningOffDesc)}</span>
        </button>
      </div>
      <div id="quotaWarningValues" class="settings-segment ${settings.quotaWarningEnabled ? "" : "is-hidden"}">
        ${[10, 20, 30, 40, 50]
          .map(
            (value) => `<button class="segment-btn ${settings.quotaWarningThreshold === value ? "active" : ""}" onclick="updateWarningThreshold(${value})">
          <span class="segment-title">${escapeHtml(t.warningValue(value))}</span>
          <span class="segment-copy">${escapeHtml(t.warningValueDesc(value))}</span>
        </button>`
          )
          .join("")}
      </div>
    </div>
    <div class="settings-block">
      <div class="settings-block-head">
        <div class="settings-block-title">${escapeHtml(t.colorThresholdTitle)}</div>
        <div class="settings-block-sub">${escapeHtml(t.colorThresholdSub)}</div>
      </div>
      <div id="quotaRedThresholdNote" class="settings-note">${escapeHtml(t.colorThresholdRedNote(settings.quotaYellowThreshold))}</div>
      <div
        class="threshold-dual"
        id="quotaThresholdDual"
        data-yellow="${settings.quotaYellowThreshold}"
        data-green="${settings.quotaGreenThreshold}"
      >
        <div class="threshold-dual-head">
          <div class="threshold-marker threshold-marker-yellow">
            <span class="threshold-marker-label">${escapeHtml(t.colorThresholdYellowTitle)}</span>
            <span class="threshold-marker-value" id="quotaYellowThresholdValue">${escapeHtml(t.colorThresholdValue(settings.quotaYellowThreshold))}</span>
          </div>
          <div class="threshold-marker threshold-marker-green">
            <span class="threshold-marker-label">${escapeHtml(t.colorThresholdGreenTitle)}</span>
            <span class="threshold-marker-value" id="quotaGreenThresholdValue">${escapeHtml(t.colorThresholdValue(settings.quotaGreenThreshold))}</span>
          </div>
        </div>
        <div class="threshold-dual-copy">
          <div class="threshold-slider-copy" id="quotaYellowThresholdCopy">${escapeHtml(t.colorThresholdYellowDesc(settings.quotaYellowThreshold))}</div>
          <div class="threshold-slider-copy" id="quotaGreenThresholdCopy">${escapeHtml(t.colorThresholdGreenDesc(settings.quotaGreenThreshold))}</div>
        </div>
        <div class="threshold-range-stack">
          <div class="threshold-range-rail"></div>
          <div class="threshold-range-fill threshold-range-fill-red" id="quotaThresholdFillRed"></div>
          <div class="threshold-range-fill threshold-range-fill-yellow" id="quotaThresholdFillYellow"></div>
          <div class="threshold-range-fill threshold-range-fill-green" id="quotaThresholdFillGreen"></div>
          <div class="threshold-bubble threshold-bubble-yellow" id="quotaYellowBubble">${escapeHtml(t.colorThresholdValue(settings.quotaYellowThreshold))}</div>
          <div class="threshold-bubble threshold-bubble-green" id="quotaGreenBubble">${escapeHtml(t.colorThresholdValue(settings.quotaGreenThreshold))}</div>
          <input
            id="quotaYellowRange"
            class="threshold-range threshold-range-yellow"
            type="range"
            min="0"
            max="100"
            step="1"
            value="${settings.quotaYellowThreshold}"
            oninput="previewQuotaThreshold('yellow', this.value)"
            onchange="commitQuotaThreshold('yellow', this.value)"
            onpointerdown="showQuotaThresholdBubble('yellow')"
            onpointerup="hideQuotaThresholdBubble('yellow')"
            onblur="hideQuotaThresholdBubble('yellow')"
          />
          <input
            id="quotaGreenRange"
            class="threshold-range threshold-range-green"
            type="range"
            min="0"
            max="100"
            step="1"
            value="${settings.quotaGreenThreshold}"
            oninput="previewQuotaThreshold('green', this.value)"
            onchange="commitQuotaThreshold('green', this.value)"
            onpointerdown="showQuotaThresholdBubble('green')"
            onpointerup="hideQuotaThresholdBubble('green')"
            onblur="hideQuotaThresholdBubble('green')"
          />
        </div>
        <div class="threshold-slider-scale">
          <span>${escapeHtml(t.colorThresholdValue(0))}</span>
          <span>${escapeHtml(t.colorThresholdValue(50))}</span>
          <span>${escapeHtml(t.colorThresholdValue(100))}</span>
        </div>
      </div>
    </div>
    <div class="settings-block">
      <div class="settings-block-head">
        <div class="settings-block-title">${escapeHtml(t.debugTitle)}</div>
        <div class="settings-block-sub">${escapeHtml(t.debugSub)}</div>
      </div>
      <div class="settings-segment">
        <button class="segment-btn ${settings.debugNetwork ? "active" : ""}" onclick="toggleDebugNetwork(true)">
          <span class="segment-title">${escapeHtml(t.debugOn)}</span>
          <span class="segment-copy">${escapeHtml(t.debugOnDesc)}</span>
        </button>
        <button class="segment-btn ${!settings.debugNetwork ? "active" : ""}" onclick="toggleDebugNetwork(false)">
          <span class="segment-title">${escapeHtml(t.debugOff)}</span>
          <span class="segment-copy">${escapeHtml(t.debugOffDesc)}</span>
        </button>
      </div>
      <div class="settings-note">${escapeHtml(t.debugNote)}</div>
    </div>
  `;
}

function renderPrimarySection(
  account: LocalizedAccount,
  t: CopySet,
  settings: { showCodeReviewQuota: boolean }
): string {
  const metrics = [
    renderPrimaryGauge(t.hourlyLabel, account.quotaSummary?.hourlyPercentage, account.quotaSummary?.hourlyResetTime, t),
    renderPrimaryGauge(t.weeklyLabel, account.quotaSummary?.weeklyPercentage, account.quotaSummary?.weeklyResetTime, t),
    renderPrimaryGauge(
      t.reviewLabel,
      account.quotaSummary?.codeReviewPercentage,
      account.quotaSummary?.codeReviewResetTime,
      t,
      `review-metric${settings.showCodeReviewQuota ? "" : " is-hidden"}`
    )
  ];

  return `
    <div class="overview-shell">
      <div class="overview-account">
        <div class="overview-account-top">
          <div class="overview-account-name">${escapeHtml(account.displayNameLabel)}</div>
          ${account.isActive ? `<div class="pill active">${escapeHtml(t.current)}</div>` : ""}
          <div class="pill plan">${escapeHtml(account.planTypeLabel)}</div>
          ${hasQuota402(account) ? `<div class="pill error">402</div>` : ""}
        </div>
        <div class="overview-account-email">${escapeHtml(account.email)}</div>
        <div class="overview-account-meta">
          ${escapeHtml(account.authProviderLabel)} · ${escapeHtml(account.accountStructureLabel)}
        </div>
        <div class="overview-meta">
          <div class="overview-meta-item">
            <span class="grid-label">${escapeHtml(t.userId)}</span>
            <span class="meta-value">${escapeHtml(account.userId ?? t.unknown)}</span>
          </div>
          <div class="overview-meta-item">
            <span class="grid-label">${escapeHtml(t.accountId)}</span>
            <span class="meta-value">${escapeHtml(account.accountId ?? t.unknown)}</span>
          </div>
          <div class="overview-meta-item">
            <span class="grid-label">${escapeHtml(t.lastRefresh)}</span>
            ${renderLiveTimestamp(account.lastQuotaAt, t.never)}
          </div>
          <div class="overview-meta-item">
            <span class="grid-label">${escapeHtml(t.organization)}</span>
            <span class="meta-value">${escapeHtml(account.organizationId ?? t.unknown)}</span>
          </div>
        </div>
      </div>
      <div class="overview-main">
        <div class="overview-head">
          <div class="overview-head-title">${escapeHtml(t.dashboardTitle)}</div>
          <div class="overview-head-sub">${escapeHtml(t.dashboardSub)}</div>
        </div>
        <div class="overview-metrics">
          <div class="metrics">
            ${metrics.join("")}
          </div>
        </div>
      </div>
      <div class="overview-actions">
        <div class="toolbar">
          <button class="toolbar-btn primary-btn" onclick="send('addAccount')">${escapeHtml(t.addAccount)}</button>
          <button class="toolbar-btn" onclick="send('importCurrent')">${escapeHtml(t.importCurrent)}</button>
          <button class="toolbar-btn" onclick="send('refreshAll')">${escapeHtml(t.refreshAll)}</button>
        </div>
      </div>
    </div>
  `;
}

function renderPrimaryContent(
  account: LocalizedAccount | undefined,
  t: CopySet,
  settings: { showCodeReviewQuota: boolean }
): string {
  return account ? renderPrimarySection(account, t, settings) : `<div class="identity">${escapeHtml(t.empty)}</div>`;
}

function renderSavedAccounts(
  accounts: LocalizedAccount[],
  t: CopySet,
  settings: { showCodeReviewQuota: boolean }
): string {
  const extraSelectedCount = accounts.filter((account) => !account.isActive && account.showInStatusBar).length;
  return `
    <div class="header" style="margin-bottom:12px;">
      <div>
        <div class="header-title" style="font-size:14px;">${escapeHtml(t.savedAccounts)}</div>
        <div class="header-sub">${escapeHtml(t.savedAccountsSub)}</div>
      </div>
    </div>
    <div class="accounts-grid">
      ${accounts.map((account) => renderSavedCard(account, t, extraSelectedCount, settings)).join("")}
    </div>
  `;
}

function renderSavedContent(
  accounts: LocalizedAccount[],
  t: CopySet,
  settings: { showCodeReviewQuota: boolean }
): string {
  if (!accounts.length) {
    return "";
  }

  return renderSavedAccounts(accounts, t, settings);
}

function renderSavedCard(
  account: LocalizedAccount,
  t: CopySet,
  extraSelectedCount: number,
  settings: { showCodeReviewQuota: boolean }
): string {
  const toggleDisabled = !account.isActive && !account.showInStatusBar && extraSelectedCount >= 2;
  const toggleTitle = toggleDisabled
    ? t.statusLimitTip
    : account.showInStatusBar
      ? t.statusToggleTipChecked
      : t.statusToggleTip;
  return `<article class="saved-card ${account.isActive ? "active" : ""}">
    <div class="saved-head">
      ${
        account.isActive
          ? ""
          : `<label class="saved-toggle ${toggleDisabled ? "disabled" : ""}" title="${escapeHtmlAttr(toggleTitle)}" aria-label="${escapeHtmlAttr(toggleTitle)}">
        <input type="checkbox" ${account.showInStatusBar ? "checked" : ""} ${toggleDisabled ? "disabled" : ""} onchange="send('toggleStatusBar', '${escapeHtmlAttr(account.id)}')" />
        <span class="saved-toggle-mark"></span>
        <span class="saved-toggle-text">${escapeHtml(t.statusShort)}</span>
      </label>`
      }
      <div class="saved-title">
        <h3>${escapeHtml(account.displayNameLabel)}</h3>
        <div class="saved-sub">${escapeHtml(account.email)}</div>
        <div class="saved-sub">${escapeHtml(t.teamName)}: ${escapeHtml(account.accountName ?? t.unknown)}</div>
        <div class="saved-sub">${escapeHtml(t.login)}: ${escapeHtml(account.authProviderLabel)}</div>
        <div class="saved-sub truncate" title="${escapeHtmlAttr(`${t.userId}: ${account.userId ?? account.accountId ?? "-"}`)}">${escapeHtml(t.userId)}: ${escapeHtml(account.userId ?? account.accountId ?? "-")}</div>
        <div class="saved-meta">
          ${account.isActive ? `<span class="pill active">${escapeHtml(t.current)}</span>` : ""}
          <span class="pill plan">${escapeHtml(account.planTypeLabel)}</span>
          ${hasQuota402(account) ? `<span class="pill error">402</span>` : ""}
          <span class="pill">${escapeHtml(account.accountStructureLabel)}</span>
        </div>
      </div>
    </div>
    <div class="saved-progress">
      ${renderMetric(t.hourlyLabel, account.quotaSummary?.hourlyPercentage, account.quotaSummary?.hourlyResetTime, t)}
      ${renderMetric(t.weeklyLabel, account.quotaSummary?.weeklyPercentage, account.quotaSummary?.weeklyResetTime, t)}
      ${renderMetric(
        t.reviewLabel,
        account.quotaSummary?.codeReviewPercentage,
        account.quotaSummary?.codeReviewResetTime,
        t,
        `review-metric${settings.showCodeReviewQuota ? "" : " is-hidden"}`
      )}
    </div>
    <div class="saved-refresh">${escapeHtml(t.lastRefresh)}: ${renderLiveTimestamp(account.lastQuotaAt, t.never)}</div>
    <div class="saved-actions">
      <button onclick="send('switch', '${escapeHtmlAttr(account.id)}')">${escapeHtml(t.switchBtn)}</button>
      <button onclick="send('refresh', '${escapeHtmlAttr(account.id)}')">${escapeHtml(t.refreshBtn)}</button>
      <button onclick="send('details', '${escapeHtmlAttr(account.id)}')">${escapeHtml(t.detailsBtn)}</button>
      <button onclick="send('remove', '${escapeHtmlAttr(account.id)}')">${escapeHtml(t.removeBtn)}</button>
    </div>
  </article>`;
}

function renderPrimaryGauge(label: string, percent: number | undefined, resetAt: number | undefined, t: CopySet, className = ""): string {
  const clamped = typeof percent === "number" ? Math.max(0, Math.min(100, percent)) : 0;
  const color = colorForPercentage(percent);
  return `<div class="metric-gauge ${className}">
    <div class="metric-gauge-ring" data-quota-percent="${typeof percent === "number" ? percent : ""}" data-quota-color-var="--gauge-color" style="--pct:${clamped}; --gauge-color:${color};">
      <div class="metric-gauge-value">${typeof percent === "number" ? `${percent}%` : "--"}</div>
    </div>
    <div class="metric-gauge-label">${escapeHtml(label)}</div>
    <div class="metric-gauge-foot">${renderLiveReset(resetAt, t)}</div>
  </div>`;
}

function hasQuota402(account: CodexAccountRecord): boolean {
  const message = account.quotaError?.message ?? "";
  if (message.includes("API returned 402")) {
    return true;
  }

  return account.quotaError?.code === "deactivated_workspace";
}

/**
 * 渲染指标行
 */
function renderMetric(label: string, percent: number | undefined, resetAt: number | undefined, t: CopySet, className = ""): string {
  const clamped = typeof percent === "number" ? Math.max(0, Math.min(100, percent)) : 0;
  const color = colorForPercentage(percent);
  return `<div class="row ${className}">
    <div class="row-head">
      <div class="label-wrap">
        <span class="metric-label">${escapeHtml(label)}</span>
      </div>
      <span class="percent" data-quota-percent="${typeof percent === "number" ? percent : ""}" data-quota-color-var="--metric-color" style="--metric-color:${color};">${typeof percent === "number" ? `${percent}%` : "--"}</span>
    </div>
    <div class="bar"><span data-quota-percent="${typeof percent === "number" ? percent : ""}" data-quota-color-var="--metric-color" style="width:${clamped}%; --metric-color:${color};"></span></div>
    <div class="foot">${renderLiveReset(resetAt, t)}</div>
  </div>`;
}

function renderLiveReset(resetAt: number | undefined, t: CopySet): string {
  const text = formatResetText(resetAt, t);
  if (!resetAt) {
    return `<span>${escapeHtml(text)}</span>`;
  }

  return `<span class="live-reset" data-reset-at="${resetAt}" data-reset-unknown="${escapeHtmlAttr(t.resetUnknown)}">${escapeHtml(text)}</span>`;
}

function renderLiveTimestamp(epochMs: number | undefined, fallback: string): string {
  if (!epochMs) {
    return `<span class="meta-value">${escapeHtml(fallback)}</span>`;
  }

  return `<span class="live-timestamp meta-value" data-epoch-ms="${epochMs}" data-never="${escapeHtmlAttr(fallback)}">${escapeHtml(formatTimestamp(epochMs))}</span>`;
}

/**
 * 格式化重置时间文本
 */
function formatResetText(resetAt: number | undefined, t: CopySet): string {
  if (!resetAt) {
    return t.resetUnknown;
  }

  const target = new Date(resetAt * 1000);
  const mm = String(target.getMonth() + 1).padStart(2, "0");
  const dd = String(target.getDate()).padStart(2, "0");
  const hh = String(target.getHours()).padStart(2, "0");
  const min = String(target.getMinutes()).padStart(2, "0");
  return `${formatRelativeReset(resetAt)} (${mm}/${dd} ${hh}:${min})`;
}

interface CopySet {
  panelTitle: string;
  brandSub: string;
  refreshPage: string;
  activeAccount: string;
  activeTeam: string;
  addAccount: string;
  importCurrent: string;
  refreshAll: string;
  dashboardTitle: string;
  dashboardSub: string;
  empty: string;
  current: string;
  hourlyLabel: string;
  weeklyLabel: string;
  reviewLabel: string;
  userId: string;
  lastRefresh: string;
  accountId: string;
  organization: string;
  savedAccounts: string;
  savedAccountsSub: string;
  teamName: string;
  login: string;
  switchBtn: string;
  refreshBtn: string;
  detailsBtn: string;
  removeBtn: string;
  settingsTitle: string;
  codexAppRestartTitle: string;
  codexAppRestartSub: string;
  restartModeAuto: string;
  restartModeAutoDesc: string;
  restartModeManual: string;
  restartModeManualDesc: string;
  restartModeNote: string;
  autoRefreshTitle: string;
  autoRefreshSub: string;
  autoRefreshOn: string;
  autoRefreshOnDesc: string;
  autoRefreshOff: string;
  autoRefreshOffDesc: string;
  autoRefreshValue: (minutes: number) => string;
  autoRefreshValueDesc: (minutes: number) => string;
  appPathTitle: string;
  appPathSub: string;
  appPathEmpty: string;
  pickPath: string;
  clearPath: string;
  dashboardSettingsTitle: string;
  dashboardSettingsSub: string;
  showReviewOn: string;
  showReviewOnDesc: string;
  showReviewOff: string;
  showReviewOffDesc: string;
  warningTitle: string;
  warningSub: string;
  warningOn: string;
  warningOnDesc: string;
  warningOff: string;
  warningOffDesc: string;
  warningValue: (percent: number) => string;
  warningValueDesc: (percent: number) => string;
  colorThresholdTitle: string;
  colorThresholdSub: string;
  colorThresholdGreenTitle: string;
  colorThresholdYellowTitle: string;
  colorThresholdValue: (percent: number) => string;
  colorThresholdGreenDesc: (percent: number) => string;
  colorThresholdYellowDesc: (percent: number) => string;
  colorThresholdRedNote: (percent: number) => string;
  colorThresholdGreenDescTemplate: string;
  colorThresholdYellowDescTemplate: string;
  colorThresholdRedNoteTemplate: string;
  debugTitle: string;
  debugSub: string;
  debugOn: string;
  debugOnDesc: string;
  debugOff: string;
  debugOffDesc: string;
  debugNote: string;
  languageTitle: string;
  languageSub: string;
  languageAuto: string;
  languageZh: string;
  languageEn: string;
  languageNote: string;
  inStatus: string;
  addToStatus: string;
  statusShort: string;
  statusToggleTip: string;
  statusToggleTipChecked: string;
  statusLimitTip: string;
  unknown: string;
  never: string;
  resetUnknown: string;
}

type LocalizedAccount = CodexAccountRecord & {
  authProviderLabel: string;
  accountStructureLabel: string;
  planTypeLabel: string;
  displayNameLabel: string;
};

const zh: CopySet = {
  panelTitle: "codex-tools 配额总览",
  brandSub: "多账号切换与配额监控主面板",
  refreshPage: "刷新页面",
  activeAccount: "当前账号",
  activeTeam: "当前团队",
  addAccount: "添加账号",
  importCurrent: "导入当前账号",
  refreshAll: "刷新配额",
  dashboardTitle: "codex-tools · 配额总览",
  dashboardSub: "主面板视图，适合停留查看和截图",
  empty: "还没有保存账号",
  current: "当前",
  hourlyLabel: "5小时",
  weeklyLabel: "每周",
  reviewLabel: "代码审查",
  userId: "用户 ID",
  lastRefresh: "最近刷新",
  accountId: "账号 ID",
  organization: "组织",
  savedAccounts: "已保存账号",
  savedAccountsSub: "集中管理已保存账号，支持切换、刷新、查看详情和删除。",
  teamName: "团队空间",
  login: "登录方式",
  switchBtn: "切换",
  refreshBtn: "刷新",
  detailsBtn: "详情",
  removeBtn: "删除",
  settingsTitle: "设置",
  codexAppRestartTitle: "Codex App 重启策略",
  codexAppRestartSub: "控制切换账号时，如何处理本机已在运行中的 Codex App。",
  restartModeAuto: "帮我自动重启",
  restartModeAutoDesc: "如果 Codex App 当前正在运行，切换账号后直接重启它。",
  restartModeManual: "每次手动点击重启",
  restartModeManualDesc: "保留最终确认权。切换账号后由你决定是否立即重启。",
  restartModeNote: "只有当 Codex App 当前已经在运行时，才会执行重启。若应用未启动，扩展不会强行拉起。",
  autoRefreshTitle: "配额自动刷新",
  autoRefreshSub: "定时刷新当前已保存账号的配额数据。",
  autoRefreshOn: "开启自动刷新",
  autoRefreshOnDesc: "按固定时间间隔自动刷新全部账号配额。",
  autoRefreshOff: "关闭",
  autoRefreshOffDesc: "不自动刷新，由你手动控制。",
  autoRefreshValue: (minutes: number) => `${minutes} 分钟`,
  autoRefreshValueDesc: (minutes: number) => `每 ${minutes} 分钟自动刷新一次全部账号配额。`,
  appPathTitle: "Codex App 启动路径",
  appPathSub: "可选。你可以指定本机 Codex App 的自定义路径；留空则使用自动检测。",
  appPathEmpty: "当前使用自动检测路径",
  pickPath: "选择路径",
  clearPath: "恢复自动检测",
  dashboardSettingsTitle: "仪表盘显示",
  dashboardSettingsSub: "控制总览面板中显示哪些信息。",
  showReviewOn: "显示 Code Review 配额",
  showReviewOnDesc: "在总览和账号卡片中展示 Code Review 配额。",
  showReviewOff: "隐藏 Code Review 配额",
  showReviewOffDesc: "精简仪表盘，只显示 5 小时和每周配额。",
  warningTitle: "超额预警",
  warningSub: "当当前账号配额低于阈值时弹出提醒。",
  warningOn: "开启预警",
  warningOnDesc: "刷新后如果低于阈值，会弹出通知提醒。",
  warningOff: "关闭预警",
  warningOffDesc: "不做额度阈值提醒。",
  warningValue: (percent: number) => `${percent}%`,
  warningValueDesc: (percent: number) => `当可用配额低于 ${percent}% 时提醒。`,
  colorThresholdTitle: "配额颜色阈值",
  colorThresholdSub: "控制绿色、黄色和红色的显示区间。",
  colorThresholdGreenTitle: "绿色起点",
  colorThresholdYellowTitle: "黄色起点",
  colorThresholdValue: (percent: number) => `${percent}%`,
  colorThresholdGreenDesc: (percent: number) => `剩余配额大于等于 ${percent}% 时显示绿色。`,
  colorThresholdYellowDesc: (percent: number) => `剩余配额大于等于 ${percent}% 且低于绿色阈值时显示黄色。`,
  colorThresholdRedNote: (percent: number) => `低于 ${percent}% 的配额会显示为红色。`,
  colorThresholdGreenDescTemplate: "剩余配额大于等于 {value}% 时显示绿色。",
  colorThresholdYellowDescTemplate: "剩余配额大于等于 {value}% 且低于绿色阈值时显示黄色。",
  colorThresholdRedNoteTemplate: "低于 {value}% 的配额会显示为红色。",
  debugTitle: "网络调试日志",
  debugSub: "控制是否将接口请求摘要写入输出面板。",
  debugOn: "开启调试日志",
  debugOnDesc: "记录脱敏后的请求结果，便于排查接口异常。",
  debugOff: "关闭调试日志",
  debugOffDesc: "默认关闭，避免无关调试输出。",
  debugNote: "日志会写入 `Codex Accounts Network` 输出通道，并对敏感字段做截断和脱敏处理。",
  languageTitle: "语言",
  languageSub: "覆盖总览面板和提示文案的语言，仅对本扩展生效。",
  languageAuto: "自动（跟随 VS Code）",
  languageZh: "简体中文",
  languageEn: "English",
  languageNote: "修改后会立即应用到本扩展的面板和提示文案，不影响 VS Code 其他界面语言。",
  inStatus: "状态栏已显示",
  addToStatus: "加入状态栏",
  statusShort: "状态栏",
  statusToggleTip: "控制该账号是否显示在底部状态栏弹窗中",
  statusToggleTipChecked: "已显示在底部状态栏弹窗中，点击可取消",
  statusLimitTip: "状态栏最多显示 2 个额外账号，请先取消一个已勾选账号",
  unknown: "未知",
  never: "从未",
  resetUnknown: "重置时间未知"
};

const en: CopySet = {
  panelTitle: "codex-tools quota summary",
  brandSub: "Main dashboard for multi-account switching and quota tracking",
  refreshPage: "Refresh Page",
  activeAccount: "Active Account",
  activeTeam: "Active Team",
  addAccount: "Add Account",
  importCurrent: "Import Current",
  refreshAll: "Refresh Quotas",
  dashboardTitle: "codex-tools · Quota Dashboard",
  dashboardSub: "Primary dashboard for monitoring, management, and screenshots",
  empty: "No saved accounts yet",
  current: "Current",
  hourlyLabel: "5h",
  weeklyLabel: "Weekly",
  reviewLabel: "Review",
  userId: "User ID",
  lastRefresh: "Last Refresh",
  accountId: "Account ID",
  organization: "Organization",
  savedAccounts: "Saved Accounts",
  savedAccountsSub: "Manage saved accounts here, including switching, refresh, details, and removal.",
  teamName: "Team Name",
  login: "Login",
  switchBtn: "Switch",
  refreshBtn: "Refresh",
  detailsBtn: "Details",
  removeBtn: "Remove",
  settingsTitle: "Settings",
  codexAppRestartTitle: "Codex App Restart Policy",
  codexAppRestartSub: "Control how the extension handles a currently running Codex App when switching accounts.",
  restartModeAuto: "Restart automatically",
  restartModeAutoDesc: "If Codex App is already running, restart it immediately after switching accounts.",
  restartModeManual: "Ask every time",
  restartModeManualDesc: "Keep the final decision in your hands and confirm each restart manually.",
  restartModeNote: "The extension only restarts Codex App when it is already running. It will not launch the desktop app from a stopped state.",
  autoRefreshTitle: "Automatic Quota Refresh",
  autoRefreshSub: "Refresh saved account quotas on a timer.",
  autoRefreshOn: "Enable auto refresh",
  autoRefreshOnDesc: "Refresh all saved account quotas on a fixed schedule.",
  autoRefreshOff: "Off",
  autoRefreshOffDesc: "Disable timed refresh and refresh manually when needed.",
  autoRefreshValue: (minutes: number) => `${minutes} min`,
  autoRefreshValueDesc: (minutes: number) => `Refresh quotas for all saved accounts every ${minutes} minutes.`,
  appPathTitle: "Codex App Launch Path",
  appPathSub: "Optional. Set a custom desktop app path or leave it empty for auto-detection.",
  appPathEmpty: "Using auto-detected app path",
  pickPath: "Choose Path",
  clearPath: "Use Auto Detect",
  dashboardSettingsTitle: "Dashboard Display",
  dashboardSettingsSub: "Control what the quota dashboard shows.",
  showReviewOn: "Show Code Review quota",
  showReviewOnDesc: "Display Code Review quota in the dashboard and account cards.",
  showReviewOff: "Hide Code Review quota",
  showReviewOffDesc: "Keep the dashboard simpler with only 5-hour and weekly quotas.",
  warningTitle: "Quota Warning",
  warningSub: "Show a warning when the active account quota drops below a threshold.",
  warningOn: "Enable warning",
  warningOnDesc: "Show notifications after refresh when quota is below the threshold.",
  warningOff: "Disable warning",
  warningOffDesc: "Do not show quota threshold notifications.",
  warningValue: (percent: number) => `${percent}%`,
  warningValueDesc: (percent: number) => `Warn when available quota drops below ${percent}%.`,
  colorThresholdTitle: "Quota Color Thresholds",
  colorThresholdSub: "Control when quotas appear green, yellow, or red.",
  colorThresholdGreenTitle: "Green starts at",
  colorThresholdYellowTitle: "Yellow starts at",
  colorThresholdValue: (percent: number) => `${percent}%`,
  colorThresholdGreenDesc: (percent: number) => `Show green when available quota is at least ${percent}%.`,
  colorThresholdYellowDesc: (percent: number) => `Show yellow when available quota is at least ${percent}% and below the green threshold.`,
  colorThresholdRedNote: (percent: number) => `Show red when available quota falls below ${percent}%.`,
  colorThresholdGreenDescTemplate: "Show green when available quota is at least {value}%.",
  colorThresholdYellowDescTemplate: "Show yellow when available quota is at least {value}% and below the green threshold.",
  colorThresholdRedNoteTemplate: "Show red when available quota falls below {value}%.",
  debugTitle: "Network Debug Logs",
  debugSub: "Control whether request summaries are written to the output panel.",
  debugOn: "Enable debug logs",
  debugOnDesc: "Record sanitized request results to help troubleshoot API issues.",
  debugOff: "Disable debug logs",
  debugOffDesc: "Default off to avoid noisy debugging output.",
  debugNote: "Logs are written to the `Codex Accounts Network` output channel with truncation and redaction applied.",
  languageTitle: "Language",
  languageSub: "Override the dashboard and prompt language for this extension only.",
  languageAuto: "Auto (follow VS Code)",
  languageZh: "Simplified Chinese",
  languageEn: "English",
  languageNote: "Changes apply immediately to this extension only and do not affect the rest of the VS Code UI.",
  inStatus: "In Status",
  addToStatus: "Add To Status",
  statusShort: "Status",
  statusToggleTip: "Control whether this account appears in the bottom status popup",
  statusToggleTipChecked: "This account is already shown in the bottom status popup. Click to remove it",
  statusLimitTip: "You can show at most 2 extra accounts in the status popup. Uncheck one first",
  unknown: "unknown",
  never: "never",
  resetUnknown: "reset unknown"
};

function getQuotaSummaryCopy(): CopySet {
  return resolveLanguage() === "zh" ? zh : en;
}

async function buildQuotaSummaryViewData(repo: AccountsRepository): Promise<{
  accounts: CodexAccountRecord[];
  settings: QuotaSummarySettings;
}> {
  return {
    accounts: await repo.listAccounts(),
    settings: readQuotaSummarySettings()
  };
}

function readQuotaSummarySettings(): QuotaSummarySettings {
  const config = vscode.workspace.getConfiguration("codexAccounts");
  const quotaThresholds = normalizeQuotaColorThresholds(
    config.get<number>("quotaGreenThreshold", 60),
    config.get<number>("quotaYellowThreshold", 20)
  );

  return {
    codexAppRestartMode: config.get<"auto" | "manual">("codexAppRestartMode") ?? "manual",
    autoRefreshMinutes: config.get<number>("autoRefreshMinutes", 0),
    codexAppPath: config.get<string>("codexAppPath", ""),
    showCodeReviewQuota: config.get<boolean>("showCodeReviewQuota", true),
    quotaWarningEnabled: config.get<boolean>("quotaWarningEnabled", true),
    quotaWarningThreshold: config.get<number>("quotaWarningThreshold", 20),
    quotaGreenThreshold: quotaThresholds.green,
    quotaYellowThreshold: quotaThresholds.yellow,
    debugNetwork: config.get<boolean>("debugNetwork", false),
    displayLanguage: config.get<"auto" | "zh" | "en">("displayLanguage", "auto")
  };
}

async function postSettingsUpdate(webview: vscode.Webview): Promise<void> {
  const settings = readQuotaSummarySettings();
  const copy = getQuotaSummaryCopy();
  const message: QuotaSummarySettingsUpdateMessage = {
    type: "settingsUpdated",
    settings,
    copy: {
      appPathEmpty: copy.appPathEmpty,
      colorThresholdRedNoteTemplate: copy.colorThresholdRedNoteTemplate,
      colorThresholdYellowDescTemplate: copy.colorThresholdYellowDescTemplate,
      colorThresholdGreenDescTemplate: copy.colorThresholdGreenDescTemplate
    }
  };
  await webview.postMessage(message);
}

async function postContentUpdate(
  webview: vscode.Webview,
  accounts: CodexAccountRecord[],
  settings: QuotaSummarySettings
): Promise<void> {
  const message: QuotaSummaryContentUpdateMessage = {
    type: "contentUpdated",
    content: buildContentPayload(accounts, settings)
  };

  await webview.postMessage(message);
}

async function postLanguageUpdate(
  webview: vscode.Webview,
  accounts: CodexAccountRecord[],
  settings: QuotaSummarySettings
): Promise<void> {
  const copy = getQuotaSummaryCopy();
  const message: QuotaSummaryLanguageUpdateMessage = {
    type: "languageUpdated",
    language: {
      lang: languageFromCopy(copy),
      brandSub: copy.brandSub,
      settingsTitle: copy.settingsTitle,
      refreshPage: copy.refreshPage,
      settingsBodyHtml: renderSettingsBody(copy, settings)
    },
    settings,
    copy: {
      appPathEmpty: copy.appPathEmpty,
      colorThresholdRedNoteTemplate: copy.colorThresholdRedNoteTemplate,
      colorThresholdYellowDescTemplate: copy.colorThresholdYellowDescTemplate,
      colorThresholdGreenDescTemplate: copy.colorThresholdGreenDescTemplate
    },
    content: buildContentPayload(accounts, settings, copy)
  };

  await webview.postMessage(message);
}

function buildContentPayload(
  accounts: CodexAccountRecord[],
  settings: QuotaSummarySettings,
  copy = getQuotaSummaryCopy()
): QuotaSummaryContentUpdateMessage["content"] {
  const localizedAccounts = [...accounts]
    .sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.email.localeCompare(b.email))
    .map((account) => accountWithTranslations(account, copy));
  const active = localizedAccounts[0];

  return {
    primaryHtml: renderPrimaryContent(active, copy, settings),
    savedHtml: renderSavedContent(localizedAccounts, copy, settings),
    showSavedSection: localizedAccounts.length > 0
  };
}

function resolveLanguage(): "zh" | "en" {
  const configured = vscode.workspace.getConfiguration("codexAccounts").get<string>("displayLanguage", "auto");
  if (configured === "zh" || configured === "en") {
    return configured;
  }

  const language = vscode.env.language.toLowerCase();
  return language.startsWith("zh") ? "zh" : "en";
}

function languageFromCopy(t: CopySet): "zh" | "en" {
  return t === zh ? "zh" : "en";
}

function accountWithTranslations(account: CodexAccountRecord, t: CopySet): LocalizedAccount {
  const lang = languageFromCopy(t);
  return {
    ...account,
    authProviderLabel: formatAuthProvider(account.authProvider, lang),
    accountStructureLabel: formatAccountStructure(account.accountStructure, lang),
    planTypeLabel: formatPlanType(account.planType, lang),
    displayNameLabel: account.displayName?.trim() ?? account.accountName?.trim() ?? account.email
  };
}

function formatAuthProvider(value: string | undefined, lang: "zh" | "en"): string {
  const provider = value?.trim() ?? "OpenAI";
  if (lang === "zh") {
    return `${provider} 登录`;
  }
  return `${provider} login`;
}

function formatAccountStructure(value: string | undefined, lang: "zh" | "en"): string {
  const normalized = (value ?? "workspace").toLowerCase();
  if (lang === "zh") {
    if (normalized === "organization") {
      return "组织空间";
    }
    if (normalized === "team") {
      return "团队空间";
    }
    if (normalized === "personal") {
      return "个人空间";
    }
    return "工作空间";
  }
  return normalized;
}

function formatPlanType(value: string | undefined, lang: "zh" | "en"): string {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) {
    return lang === "zh" ? "未知" : "unknown";
  }

  const labels: Record<string, { zh: string; en: string }> = {
    free: { zh: "Free", en: "Free" },
    plus: { zh: "Plus", en: "Plus" },
    pro: { zh: "Pro", en: "Pro" },
    team: { zh: "Team", en: "Team" },
    business: { zh: "Business", en: "Business" },
    enterprise: { zh: "Enterprise", en: "Enterprise" }
  };

  const matched = labels[normalized];
  if (matched) {
    return lang === "zh" ? matched.zh : matched.en;
  }

  return normalized;
}
