import type { DashboardLanguage, DashboardLanguageOption } from "../../localization/languages";

export type DashboardSettingKey =
  | "codexAppRestartEnabled"
  | "codexAppRestartMode"
  | "autoRefreshMinutes"
  | "autoSwitchEnabled"
  | "autoSwitchHourlyThreshold"
  | "autoSwitchWeeklyThreshold"
  | "showCodeReviewQuota"
  | "quotaWarningEnabled"
  | "quotaWarningThreshold"
  | "quotaGreenThreshold"
  | "quotaYellowThreshold"
  | "debugNetwork"
  | "displayLanguage";

export interface DashboardSettings {
  codexAppRestartEnabled: boolean;
  codexAppRestartMode: "auto" | "manual";
  autoRefreshMinutes: number;
  autoSwitchEnabled: boolean;
  autoSwitchHourlyThreshold: number;
  autoSwitchWeeklyThreshold: number;
  codexAppPath: string;
  resolvedCodexAppPath: string;
  showCodeReviewQuota: boolean;
  quotaWarningEnabled: boolean;
  quotaWarningThreshold: number;
  quotaGreenThreshold: number;
  quotaYellowThreshold: number;
  debugNetwork: boolean;
  displayLanguage: DashboardLanguageOption;
}

export interface DashboardCopy {
  panelTitle: string;
  brandSub: string;
  refreshPage: string;
  addAccount: string;
  importCurrent: string;
  refreshAll: string;
  shareToken: string;
  shareTokenDisabledTip: string;
  dashboardTitle: string;
  dashboardSub: string;
  empty: string;
  noActiveAccountTitle: string;
  noActiveAccountSub: string;
  primaryAccount: string;
  current: string;
  disabledTag: string;
  authErrorTag: string;
  quotaErrorTag: string;
  reauthorizeBtn: string;
  reloadBtn: string;
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
  addAccountModalTitle: string;
  shareTokenModalTitle: string;
  oauthTab: string;
  importJsonTab: string;
  authorizationLink: string;
  copyLink: string;
  openInBrowser: string;
  manualCallbackLabel: string;
  manualCallbackPlaceholder: string;
  authorizedContinue: string;
  oauthReadyHint: string;
  jsonPreview: string;
  copyJson: string;
  copySuccess: string;
  downloadJson: string;
  importJson: string;
  importJsonPlaceholder: string;
  importJsonSubmit: string;
  importJsonHint: string;
  importJsonExamplesSummary: string;
  importJsonExamplesHint: string;
  importJsonSingleExampleLabel: string;
  importJsonBatchExampleLabel: string;
  importJsonChooseFile: string;
  importJsonFileReadError: string;
  shareSelectedCount: string;
  closeModal: string;
  showSensitive: string;
  hideSensitive: string;
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
  autoRefreshValueTemplate: string;
  autoRefreshValueDescTemplate: string;
  autoSwitchTitle: string;
  autoSwitchSub: string;
  autoSwitchOn: string;
  autoSwitchOnDesc: string;
  autoSwitchOff: string;
  autoSwitchOffDesc: string;
  autoSwitchThresholdSuffix: string;
  autoSwitchThresholdDescTemplate: string;
  autoSwitchAnyNote: string;
  autoSwitchToastSwitched: string;
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
  warningValueDescTemplate: string;
  colorThresholdTitle: string;
  colorThresholdSub: string;
  colorThresholdGreenTitle: string;
  colorThresholdYellowTitle: string;
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
  statusShort: string;
  selectAccount: string;
  deselectAccount: string;
  statusToggleTip: string;
  statusToggleTipChecked: string;
  statusLimitTip: string;
  unknown: string;
  never: string;
  resetUnknown: string;
}

type DashboardMetricKey = "hourly" | "weekly" | "review";

export interface DashboardMetricViewModel {
  key: DashboardMetricKey;
  label: string;
  percentage?: number;
  resetAt?: number;
  visible: boolean;
}

export interface DashboardAccountViewModel {
  id: string;
  displayName: string;
  email: string;
  accountName?: string;
  authProviderLabel: string;
  accountStructureLabel: string;
  planTypeLabel: string;
  userId?: string;
  accountId?: string;
  organizationId?: string;
  isActive: boolean;
  isCurrentWindowAccount: boolean;
  showInStatusBar: boolean;
  canToggleStatusBar: boolean;
  statusToggleTitle: string;
  hasQuota402: boolean;
  quotaIssueKind?: "disabled" | "auth" | "quota";
  lastQuotaAt?: number;
  metrics: DashboardMetricViewModel[];
}

export interface DashboardState {
  lang: DashboardLanguage;
  panelTitle: string;
  brandSub: string;
  logoUri: string;
  settings: DashboardSettings;
  copy: DashboardCopy;
  accounts: DashboardAccountViewModel[];
}

export type DashboardActionName =
  | "addAccount"
  | "importCurrent"
  | "refreshAll"
  | "shareTokens"
  | "copyText"
  | "openExternalUrl"
  | "downloadJsonFile"
  | "importSharedJson"
  | "prepareOAuthSession"
  | "completeOAuthSession"
  | "refreshView"
  | "reloadPrompt"
  | "reauthorize"
  | "details"
  | "switch"
  | "refresh"
  | "remove"
  | "toggleStatusBar";

export interface DashboardOAuthSessionDescriptor {
  sessionId: string;
  authUrl: string;
  redirectUri: string;
}

export interface DashboardActionPayload {
  accountIds?: string[];
  jsonText?: string;
  text?: string;
  url?: string;
  filename?: string;
  oauthSessionId?: string;
  callbackUrl?: string;
}

export interface DashboardActionResultPayload {
  sharedJson?: string;
  oauthSession?: DashboardOAuthSessionDescriptor;
  importedCount?: number;
  importedEmails?: string[];
  email?: string;
}

export type DashboardHostMessage =
  | {
      type: "dashboard:snapshot";
      state: DashboardState;
    }
  | {
      type: "dashboard:action-result";
      requestId: string;
      action: DashboardActionName;
      accountId?: string;
      status: "completed" | "failed";
      payload?: DashboardActionResultPayload;
      error?: string;
    };

export type DashboardClientMessage =
  | { type: "dashboard:ready" }
  | {
      type: "dashboard:action";
      requestId: string;
      action: DashboardActionName;
      accountId?: string;
      payload?: DashboardActionPayload;
    }
  | {
      type: "dashboard:setting";
      key: DashboardSettingKey;
      value: string | number | boolean;
    }
  | { type: "dashboard:pickCodexAppPath" }
  | { type: "dashboard:clearCodexAppPath" };
