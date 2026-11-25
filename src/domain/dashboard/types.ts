import type { DashboardLanguage, DashboardLanguageOption } from "../../localization/languages";
import type { WakeupSnapshot, WakeupTaskInput } from "../wakeup/types";
import type {
  CodexAnnouncementState,
  CodexImportPreviewSummary,
  CodexImportResultSummary,
  CodexIndexHealthSummary,
  CodexResetCreditHistoryPage,
  CodexResetCreditLocalRecord
} from "../../core/types";

export type DashboardSettingKey =
  | "dashboardTheme"
  | "codexAppRestartEnabled"
  | "codexAppRestartMode"
  | "backgroundTokenRefreshEnabled"
  | "autoRefreshMinutes"
  | "autoRefreshPlanTypes"
  | "autoSwitchEnabled"
  | "hourlyQuotaControlEnabled"
  | "autoSwitchReloadWindowEnabled"
  | "autoSwitchHourlyThreshold"
  | "autoSwitchWeeklyThreshold"
  | "autoSwitchLockMinutes"
  | "quotaWarningEnabled"
  | "quotaWarningThreshold"
  | "quotaGreenThreshold"
  | "quotaYellowThreshold"
  | "debugNetwork"
  | "displayLanguage";

export interface DashboardSettings {
  dashboardTheme: DashboardThemeOption;
  codexAppRestartEnabled: boolean;
  codexAppRestartMode: "auto" | "manual";
  backgroundTokenRefreshEnabled: boolean;
  autoRefreshMinutes: number;
  autoRefreshPlanTypes?: readonly string[];
  autoSwitchEnabled: boolean;
  hourlyQuotaControlEnabled: boolean;
  autoSwitchReloadWindowEnabled: boolean;
  autoSwitchHourlyThreshold: number;
  autoSwitchWeeklyThreshold: number;
  autoSwitchLockMinutes: number;
  codexAppPath: string;
  resolvedCodexAppPath: string;
  quotaWarningEnabled: boolean;
  quotaWarningThreshold: number;
  quotaGreenThreshold: number;
  quotaYellowThreshold: number;
  debugNetwork: boolean;
  displayLanguage: DashboardLanguageOption;
}

export type DashboardThemeOption = "auto" | "dark" | "light";

export const AUTO_REFRESH_PLANS = ["free", "plus", "pro", "business", "enterprise", "edu", "other"] as const;

export interface DashboardCopy {
  autoRefreshPlansLabel: string;
  localResetHistoryTitle: string;
  localResetNoCharge: string;
  moveAccountUp: string;
  moveAccountDown: string;
  batchResultPartial: string;
  batchResultSuperseded: string;
  panelTitle: string;
  brandSub: string;
  refreshPage: string;
  githubProject: string;
  githubProjectTip: string;
  announcementsTitle: string;
  announcementsTooltip: string;
  announcementsEmpty: string;
  announcementsRefresh: string;
  announcementsRefreshing: string;
  announcementsMarkAllRead: string;
  announcementsGotIt: string;
  announcementsPinned: string;
  announcementsTypeInfo: string;
  announcementsTypeFeature: string;
  announcementsTypeWarning: string;
  announcementsTypeUrgent: string;
  announcementsJustNow: string;
  announcementsMinutesAgo: string;
  announcementsHoursAgo: string;
  announcementsDaysAgo: string;
  addAccount: string;
  importCurrent: string;
  refreshAll: string;
  shareToken: string;
  shareTokenDisabledTip: string;
  shareTokenModeHint: string;
  tokenAutomationTitle: string;
  tokenAutomationSub: string;
  tokenAutomationOn: string;
  tokenAutomationOnDesc: string;
  tokenAutomationOff: string;
  tokenAutomationOffDesc: string;
  tokenAutomationLastCheck: string;
  tokenAutomationLastRefresh: string;
  tokenAutomationNextCheck: string;
  tokenAutomationLastFailure: string;
  tokenAutomationHealthy: string;
  tokenAutomationExpiring: string;
  tokenAutomationRefreshFailed: string;
  tokenAutomationReauthorize: string;
  tokenAutomationDisabled: string;
  tokenAutomationQuota: string;
  quotaRefreshSuccess: string;
  quotaRefreshFailed: string;
  quotaRefreshStale: string;
  quotaRefreshRateLimited: string;
  quotaRefreshRetryAt: string;
  resyncProfileBtn: string;
  syncProfileBtn: string;
  editTagsBtn: string;
  addTagsBtn: string;
  removeTagsBtn: string;
  batchActionsTitle: string;
  batchRefreshBtn: string;
  batchResyncBtn: string;
  batchRemoveBtn: string;
  batchExportBtn: string;
  batchSelectedCount: string;
  batchResultTitle: string;
  batchResultSuccess: string;
  batchResultFailed: string;
  batchResultOverwrite: string;
  batchResultFailures: string;
  tagsLabel: string;
  tagsPlaceholder: string;
  tagsHelp: string;
  tagsRequiredError: string;
  tagsTooManyError: string;
  tagsTooLongError: string;
  saveTagsBtn: string;
  clearTagsBtn: string;
  lockAutoSwitchBtn: string;
  unlockAutoSwitchBtn: string;
  autoSwitchLockedUntil: string;
  autoSwitchRuleQuota: string;
  recoveryTitle: string;
  recoveryRestored: string;
  recoveryCorrupted: string;
  recoveryBackups: string;
  recoveryLastError: string;
  recoveryRestoreBackupBtn: string;
  recoveryRestoreAuthBtn: string;
  recoveryImportJsonBtn: string;
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
  resetCreditsBtn: string;
  resetCreditsRetryBtn: string;
  resetCreditsManageBtn: string;
  resetCreditsLabel: string;
  resetCreditDialogTitle: string;
  resetCreditDialogHint: string;
  resetCreditAvailableTab: string;
  resetCreditHistoryTab: string;
  resetCreditRefresh: string;
  resetCreditUse: string;
  resetCreditFull: string;
  resetCreditItem: string;
  resetCreditExpires: string;
  resetCreditNextExpiry: string;
  resetCreditExpiryUnknown: string;
  resetCreditNoAvailable: string;
  resetCreditInventoryLoading: string;
  resetCreditInventoryError: string;
  resetCreditCardsUnavailable: string;
  resetCreditsPendingNote: string;
  resetCreditHistoryTitle: string;
  resetCreditHistoryLoading: string;
  resetCreditHistoryEmpty: string;
  resetCreditHistoryError: string;
  resetCreditHistoryRetry: string;
  resetCreditHistoryMore: string;
  resetCreditHistoryGranted: string;
  resetCreditHistoryRedeemed: string;
  resetCreditHistoryActivity: string;
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
  cancelOauthConfirm: string;
  continueOauthBtn: string;
  cancelOauthBtn: string;
  oauthReadyHint: string;
  deviceOauthStart: string;
  deviceOauthPreparing: string;
  deviceOauthPrompt: string;
  deviceOauthCancel: string;
  deviceOauthCancelPending: string;
  deviceOauthFinishing: string;
  deviceOauthCopy: string;
  deviceOauthCopyLink: string;
  deviceOauthBrowserFailed: string;
  deviceOauthExpiresAt: string;
  jsonPreview: string;
  copyJson: string;
  copySuccess: string;
  downloadJson: string;
  importJson: string;
  importJsonPlaceholder: string;
  importJsonSessionHint: string;
  importJsonSubmit: string;
  importJsonHint: string;
  importJsonValidate: string;
  importProbeSelected: string;
  importProbeNotChecked: string;
  importProbeOk: string;
  importProbeUnauthorized: string;
  importProbeRateLimited: string;
  importProbeFailed: string;
  importJsonSummaryTitle: string;
  importJsonSummaryTotal: string;
  importJsonSummaryValid: string;
  importJsonSummaryOverwrite: string;
  importJsonSummaryInvalid: string;
  importJsonSummaryFailures: string;
  importJsonResultsTitle: string;
  importJsonResultsSuccess: string;
  importJsonResultsOverwrite: string;
  importJsonResultsFailed: string;
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
  hourlyQuotaControlTitle: string;
  hourlyQuotaControlSub: string;
  hourlyQuotaControlOnDesc: string;
  hourlyQuotaControlOffDesc: string;
  autoSwitchTitle: string;
  autoSwitchSub: string;
  autoSwitchOn: string;
  autoSwitchOnDesc: string;
  autoSwitchOff: string;
  autoSwitchOffDesc: string;
  autoSwitchThresholdSuffix: string;
  autoSwitchThresholdDescTemplate: string;
  autoSwitchAnyNote: string;
  autoSwitchReloadTitle: string;
  autoSwitchReloadSub: string;
  autoSwitchLockMinutesTitle: string;
  autoSwitchLockMinutesSub: string;
  autoSwitchLockOff: string;
  autoSwitchLockValueTemplate: string;
  autoSwitchLockValueDescTemplate: string;
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
  warningWeeklyOnlySub: string;
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
  subscriptionNoPaidPlan: string;
  subscriptionExpiryUnconfirmed: string;
  subscriptionExpired: string;
  unknown: string;
  never: string;
  resetUnknown: string;
}

type DashboardMetricKey = string;

export interface DashboardMetricViewModel {
  key: DashboardMetricKey;
  label: string;
  percentage?: number;
  resetAt?: number;
  requestsLeft?: number;
  requestsLimit?: number;
  visible: boolean;
}

export interface DashboardAccountViewModel {
  id: string;
  displayName: string;
  email: string;
  authMode?: "chatgpt" | "oauth";
  accountName?: string;
  tags: string[];
  authProviderLabel: string;
  accountStructureLabel: string;
  workspaceLabel: string;
  isTeamWorkspace: boolean;
  subscriptionText: string;
  subscriptionTitle: string;
  subscriptionColor?: string;
  addMethodLabel: string;
  addedAtLabel: string;
  statusColor?: string;
  planTypeLabel: string;
  creditsText?: string;
  userId?: string;
  accountId?: string;
  organizationId?: string;
  isActive: boolean;
  isCurrentWindowAccount: boolean;
  reorderable?: boolean;
  showInStatusBar: boolean;
  canToggleStatusBar: boolean;
  statusToggleTitle: string;
  hasQuota402: boolean;
  quotaIssueKind?: "disabled" | "auth" | "quota";
  healthKind: "healthy" | "expiring" | "refresh_failed" | "reauthorize" | "disabled" | "quota";
  healthLabel: string;
  healthMessage?: string;
  healthIssueKey?: string;
  dismissedHealth: boolean;
  lastTokenCheckAt?: number;
  lastTokenRefreshAt?: number;
  lastTokenRefreshError?: string;
  lastQuotaAt?: number;
  quotaRefreshFailed?: boolean;
  quotaHttpStatus?: number;
  quotaRetryAt?: number;
  resetCreditsAvailable?: number;
  resetCreditsNextExpiresAt?: number;
  resetRedemptionPending?: boolean;
  resetRedemptionCreditId?: string;
  autoSwitchLockedUntil?: number;
  metrics: DashboardMetricViewModel[];
}

export interface DashboardTokenAutomationViewModel {
  enabled: boolean;
  lastCheckAt?: number;
  nextCheckAt?: number;
  lastRefreshAt?: number;
  lastFailureMessage?: string;
}

export type DashboardBatchResultKind =
  | "tags_set"
  | "tags_add"
  | "tags_remove"
  | "batch_refresh"
  | "batch_resync"
  | "batch_remove";

export interface DashboardBatchResultFailure {
  accountId?: string;
  email?: string;
  message: string;
  outcome?: "partial" | "superseded";
}

export interface DashboardBatchResult {
  kind: DashboardBatchResultKind;
  successCount: number;
  failedCount: number;
  partialCount?: number;
  supersededCount?: number;
  overwriteCount?: number;
  failures: DashboardBatchResultFailure[];
}

export interface DashboardState {
  lang: DashboardLanguage;
  panelTitle: string;
  brandSub: string;
  logoUri: string;
  settings: DashboardSettings;
  copy: DashboardCopy;
  tokenAutomation: DashboardTokenAutomationViewModel;
  announcements: CodexAnnouncementState;
  indexHealth: CodexIndexHealthSummary;
  accounts: DashboardAccountViewModel[];
  wakeup?: WakeupSnapshot;
}

export type DashboardActionName =
  | "saveWakeupTask"
  | "removeWakeupTask"
  | "toggleWakeupTask"
  | "runWakeupTask"
  | "addAccount"
  | "importCurrent"
  | "refreshAll"
  | "refreshAnnouncements"
  | "markAnnouncementRead"
  | "markAllAnnouncementsRead"
  | "shareTokens"
  | "restoreFromBackup"
  | "restoreFromAuthJson"
  | "copyText"
  | "openExternalUrl"
  | "downloadJsonFile"
  | "previewImportSharedJson"
  | "importSharedJson"
  | "prepareOAuthSession"
  | "prepareDeviceOAuthSession"
  | "completeDeviceOAuthSession"
  | "cancelDeviceOAuthSession"
  | "cancelOAuthSession"
  | "startOAuthAutoFlow"
  | "completeOAuthSession"
  | "updateTags"
  | "setAutoSwitchLock"
  | "batchRefresh"
  | "batchResyncProfile"
  | "batchRemove"
  | "refreshView"
  | "reloadPrompt"
  | "reauthorize"
  | "resyncProfile"
  | "dismissHealthIssue"
  | "details"
  | "switch"
  | "refresh"
  | "remove"
  | "toggleStatusBar"
  | "getResetCredits"
  | "getResetCreditHistory"
  | "getLocalResetCreditHistory"
  | "moveDashboardAccount"
  | "consumeResetCredit";

export interface DashboardOAuthSessionDescriptor {
  sessionId: string;
  authUrl: string;
  redirectUri: string;
}

export interface DashboardDeviceOAuthGrant {
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
}

export type DashboardDeviceOAuthCancellation = "cancelled" | "committing" | "inactive";

export interface DashboardActionPayload {
  wakeupTask?: WakeupTaskInput;
  wakeupTaskId?: string;
  enabled?: boolean;
  accountIds?: string[];
  moveTargetAccountId?: string;
  moveAfter?: boolean;
  jsonText?: string;
  probeImportIndexes?: number[];
  text?: string;
  url?: string;
  filename?: string;
  oauthSessionId?: string;
  deviceSessionId?: string;
  callbackUrl?: string;
  issueKey?: string;
  recoveryMode?: boolean;
  tags?: string[];
  mode?: "set" | "add" | "remove";
  lockMinutes?: number;
  announcementId?: string;
  privacyMode?: boolean;
  resetCreditHistoryCursor?: string;
  resetCreditId?: string;
}

export interface DashboardActionResultPayload {
  sharedJson?: string;
  oauthSession?: DashboardOAuthSessionDescriptor;
  deviceOAuthGrant?: DashboardDeviceOAuthGrant;
  deviceOAuthCancellation?: DashboardDeviceOAuthCancellation;
  externalUrlOpened?: boolean;
  importPreview?: CodexImportPreviewSummary;
  importResult?: CodexImportResultSummary;
  batchResult?: DashboardBatchResult;
  importedCount?: number;
  importedEmails?: string[];
  email?: string;
  restoredCount?: number;
  resetCredits?: import("../../core/types").CodexResetCreditsSnapshot;
  resetCreditHistory?: CodexResetCreditHistoryPage;
  localResetCreditHistory?: CodexResetCreditLocalRecord[];
  resetCreditHistoryChanged?: true;
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
