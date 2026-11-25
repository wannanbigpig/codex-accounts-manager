import { render } from "preact";
import { useEffect, useMemo, useReducer, useState } from "preact/hooks";
import packageJson from "../../package.json";
import type { DashboardAccountViewModel, DashboardBatchResult, DashboardHostMessage } from "../../src/domain/dashboard/types";
import { getWakeupCopy } from "../../src/domain/wakeup/copy";
import { AnnouncementCenter } from "./announcementCenter";
import { BatchSelectionBar, OverviewSection, RecoveryPanel } from "./components";
import { postMessageToHost } from "./host";
import { formatSavedAccountsSummary, getSensitiveDisplayValue, normalizeThresholds, resolveLockMinutes, resolveOverviewAccount } from "./helpers";
import { useDashboardActions, useDashboardHostSync, useDashboardModals } from "./hooks";
import { BellIcon, EyeIcon, EyeOffIcon, GitHubIcon, InfoIcon } from "./icons";
import { AboutModal, AddAccountModal, ConfirmCancelOauthModal, SettingsOverlay, ShareTokenModal } from "./panels";
import { createResetCreditHistoryController, resetCreditHistoryScope, type ResetCreditHistoryState } from "./resetCreditHistory";
import { ResetCreditsModal } from "./resetCreditsModal";
import { SavedAccountCard } from "./savedAccountCard";
import { createInitialState, reducer } from "./state";
import { resolveDashboardThemeFromMedia } from "./theme";
import { ClockIcon, WakeupModal } from "./wakeupModal";

const GITHUB_PROJECT_URL = "https://github.com/wannanbigpig/codex-tools";

function App() {
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [announcementsOpen, setAnnouncementsOpen] = useState(false);
  const [wakeupOpen, setWakeupOpen] = useState(false);
  const [wakeupAccountId, setWakeupAccountId] = useState<string>();
  const [wakeupResult, setWakeupResult] = useState<Extract<DashboardHostMessage, { type: "dashboard:action-result" }>>();
  const [resetCreditHistory, setResetCreditHistory] = useState<ResetCreditHistoryState>();
  const [manualRefreshFailures, setManualRefreshFailures] = useState<Record<string, number>>({});
  const [batchSyncResult, setBatchSyncResult] = useState<DashboardBatchResult>();
  const resetCredits = useMemo(() => createResetCreditHistoryController(postMessageToHost, setResetCreditHistory), []);
  const { patchSettings, sendAction, sendSetting, isActionPending, hasGlobalPendingAction } = useDashboardActions(
    state,
    dispatch
  );
  const snapshot = state.snapshot;
  const resetCreditsAccount = snapshot?.accounts.find((account) => account.id === resetCreditHistory?.accountId);
  const resetCreditsScope = resetCreditsAccount ? resetCreditHistoryScope(resetCreditsAccount) : undefined;
  const modals = useDashboardModals({
    dispatch,
    sendAction,
    importJsonFileReadError: snapshot?.copy.importJsonFileReadError ?? "Failed to read JSON file."
  });
  useDashboardHostSync({
    handleHostMessage: (message) => {
      modals.handleHostMessage(message);
      if (message.type === "dashboard:action-result") {
        if (message.payload?.batchResult?.kind === "batch_resync") {
          setBatchSyncResult(message.payload.batchResult);
        }
        const pending = state.pendingActions.find((action) => action.requestId === message.requestId);
        if (message.action === "refresh" && message.accountId && pending?.accountId === message.accountId) {
          const id = message.accountId;
          setManualRefreshFailures((previous) => {
            const next = { ...previous };
            if (message.status === "failed") {
              next[id] = pending.requestedAt;
            } else {
              delete next[id];
            }
            return next;
          });
        }
        resetCredits.applyActionResult(message);
        if (message.action.includes("Wakeup")) {
          setWakeupResult(message);
        }
      }
    },
    handleEscape: () => {
      if (resetCreditHistory) {
        resetCredits.close();
        return true;
      }
      if (wakeupOpen) {
        setWakeupOpen(false);
        return true;
      }
      return modals.handleEscape(isActionPending("completeOAuthSession"));
    }
  });
  useEffect(() => {
    if (!snapshot || !resetCreditHistory) {
      return;
    }
    if (!resetCreditsAccount || resetCreditsScope === undefined) {
      resetCredits.close();
    } else if (resetCreditsScope !== resetCreditHistory.scope) {
      resetCredits.open(resetCreditsAccount.id, resetCreditsScope);
    }
  }, [resetCreditHistory, resetCredits, resetCreditsAccount, resetCreditsScope, snapshot]);
  useEffect(() => {
    const preference = snapshot?.settings.dashboardTheme ?? "auto";
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const applyResolvedTheme = () => {
      root.dataset["themePreference"] = preference;
      root.dataset["theme"] = resolveDashboardThemeFromMedia(preference, media);
    };

    applyResolvedTheme();
    media.addEventListener("change", applyResolvedTheme);
    const observer = new MutationObserver(applyResolvedTheme);
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });

    return () => {
      media.removeEventListener("change", applyResolvedTheme);
      observer.disconnect();
    };
  }, [snapshot?.settings.dashboardTheme]);

  if (!snapshot) {
    return (
      <div class="panel">
        <section class="section">
          <div class="identity">Loading...</div>
        </section>
      </div>
    );
  }

  const activeAccount = snapshot.accounts.find((account) => account.isActive);
  const overviewAccount = resolveOverviewAccount(snapshot.accounts);

  const handleAutoRefreshToggle = (enabled: boolean): void => {
    const nextMinutes = enabled ? state.lastEnabledAutoRefreshMinutes || 15 : 0;
    patchSettings({ autoRefreshMinutes: nextMinutes });
    sendSetting("autoRefreshMinutes", nextMinutes);
  };

  const handleAutoRefreshValue = (minutes: number): void => {
    patchSettings({ autoRefreshMinutes: minutes });
    sendSetting("autoRefreshMinutes", minutes);
  };

  const handleThresholdPreview = (key: "yellow" | "green", value: number): void => {
    const thresholds =
      key === "yellow"
        ? normalizeThresholds(snapshot.settings.quotaGreenThreshold, value)
        : normalizeThresholds(value, snapshot.settings.quotaYellowThreshold);

    patchSettings({
      quotaGreenThreshold: thresholds.green,
      quotaYellowThreshold: thresholds.yellow
    });
  };

  const handleThresholdCommit = (key: "yellow" | "green", value: number): void => {
    const thresholds =
      key === "yellow"
        ? normalizeThresholds(snapshot.settings.quotaGreenThreshold, value)
        : normalizeThresholds(value, snapshot.settings.quotaYellowThreshold);

    patchSettings({
      quotaGreenThreshold: thresholds.green,
      quotaYellowThreshold: thresholds.yellow
    });
    sendSetting("quotaYellowThreshold", thresholds.yellow);
    sendSetting("quotaGreenThreshold", thresholds.green);
  };

  const selectedAccountIds = new Set(state.selectedAccountIds);
  const selectedCount = state.selectedAccountIds.length;
  const isAccountBusy = (accountId: string): boolean =>
    hasGlobalPendingAction || state.pendingActions.some((request) => request.accountId === accountId);
  const privacyToggleLabel = state.privacyMode ? snapshot.copy.showSensitive : snapshot.copy.hideSensitive;
  const announcementUnreadCount = snapshot.announcements.unreadIds.length;
  const prepareOAuthPending = isActionPending("prepareOAuthSession");
  const startOAuthAutoPending = isActionPending("startOAuthAutoFlow");
  const completeOAuthPending = isActionPending("completeOAuthSession");
  const importSharedPending = isActionPending("importSharedJson");
  const previewImportPending = isActionPending("previewImportSharedJson");
  const restoreBackupPending = isActionPending("restoreFromBackup");
  const restoreAuthPending = isActionPending("restoreFromAuthJson");
  const sharePending = isActionPending("shareTokens");
  const downloadSharePending = isActionPending("downloadJsonFile");
  const batchRefreshPending = isActionPending("batchRefresh");
  const batchResyncPending = isActionPending("batchResyncProfile");
  const batchRemovePending = isActionPending("batchRemove");
  const batchTagsPending = state.pendingActions.some(
    (request) => request.action === "updateTags" && request.accountId == null
  );
  const invalidAccountCount = snapshot.accounts.filter(
    (account) =>
      !account.dismissedHealth &&
      (account.healthKind === "reauthorize" ||
        account.healthKind === "refresh_failed" ||
        account.healthKind === "disabled" ||
        account.healthKind === "quota")
  ).length;
  const validAccountCount = snapshot.accounts.length - invalidAccountCount;

  const handleShareTokens = (): void => {
    if (!selectedCount) {
      return;
    }
    sendAction("shareTokens", undefined, { accountIds: state.selectedAccountIds });
  };

  const handleEditAccountTags = (account: DashboardAccountViewModel): void => {
    sendAction("updateTags", account.id, {
      mode: "set"
    });
  };

  const handleBatchTagMutation = (mode: "add" | "remove"): void => {
    if (!selectedCount) {
      return;
    }
    sendAction("updateTags", undefined, {
      accountIds: state.selectedAccountIds,
      mode
    });
  };

  const handleAutoSwitchLock = (): void => {
    if (!activeAccount) {
      return;
    }
    sendAction("setAutoSwitchLock", activeAccount.id, {
      lockMinutes: activeAccount.autoSwitchLockedUntil ? 0 : resolveLockMinutes(snapshot.settings.autoSwitchLockMinutes)
    });
  };

  return (
    <>
      <div class={`panel ${state.privacyMode ? "privacy-hidden" : ""}`}>
        {snapshot.indexHealth.status !== "healthy" ? (
          <section class="section">
            <RecoveryPanel
              copy={snapshot.copy}
              health={snapshot.indexHealth}
              restoreBackupPending={restoreBackupPending}
              restoreAuthPending={restoreAuthPending}
              restoreJsonPending={importSharedPending && modals.importRecoveryMode}
              onRestoreBackup={() => sendAction("restoreFromBackup")}
              onRestoreAuth={() => sendAction("restoreFromAuthJson")}
              onImportJson={modals.openRecoveryImportModal}
            />
          </section>
        ) : null}
        <section class="section">
          <div class="hero">
            <div class="brand">
              <img class="logo" src={snapshot.logoUri} alt="Codex Accounts Manager logo" />
              <div>
                <h1>Codex Accounts Manager</h1>
                <p>{snapshot.brandSub}</p>
              </div>
            </div>
            <div class="hero-settings">
              <button
                id="wakeupButton"
                class={`settings-btn action-btn icon-only wakeup-button ${snapshot.wakeup?.tasks.some((task) => task.enabled) ? "is-enabled" : ""}`}
                type="button"
                title={getWakeupCopy(snapshot.lang).title}
                aria-label={getWakeupCopy(snapshot.lang).title}
                onClick={() => {
                  setWakeupAccountId(undefined);
                  setWakeupResult(undefined);
                  setWakeupOpen(true);
                }}
              >
                <span class="button-face">
                  <span class="button-icon"><ClockIcon /></span>
                </span>
                {snapshot.wakeup?.tasks.some((task) => task.enabled) ? <span class="wakeup-button-dot" /> : null}
                <span class="button-tip" aria-hidden="true">
                  {getWakeupCopy(snapshot.lang).title}
                </span>
              </button>
              <button
                id="announcementsButton"
                class={`settings-btn action-btn icon-only announcement-btn ${announcementUnreadCount > 0 ? "has-unread" : ""}`}
                type="button"
                title={snapshot.copy.announcementsTooltip}
                aria-label={snapshot.copy.announcementsTooltip}
                onClick={() => setAnnouncementsOpen(true)}
              >
                <span class="button-face">
                  <span class="button-icon">
                    <BellIcon />
                  </span>
                </span>
                {announcementUnreadCount > 0 ? (
                  <span class="announcement-button-badge" aria-label={`${announcementUnreadCount} unread`}>
                    {announcementUnreadCount > 9 ? "9+" : announcementUnreadCount}
                  </span>
                ) : null}
                <span class="button-tip" aria-hidden="true">
                  {snapshot.copy.announcementsTooltip}
                </span>
              </button>
              <button
                id="githubProjectButton"
                class="settings-btn action-btn github-project-btn"
                type="button"
                title={snapshot.copy.githubProject}
                aria-label={snapshot.copy.githubProject}
                onClick={() => sendAction("openExternalUrl", undefined, { url: GITHUB_PROJECT_URL })}
              >
                <span class="button-face">
                  <span class="button-icon">
                    <GitHubIcon />
                  </span>
                </span>
                <span class="button-tip" aria-hidden="true">
                  {snapshot.copy.githubProjectTip}
                </span>
              </button>
              <button
                id="privacyToggleButton"
                class={`settings-btn action-btn icon-only ${state.privacyMode ? "is-active" : ""}`}
                type="button"
                title={privacyToggleLabel}
                aria-label={privacyToggleLabel}
                aria-pressed={state.privacyMode}
                onClick={() => dispatch({ type: "toggle-privacy" })}
              >
                <span class="button-face">
                  <span class="button-icon">{state.privacyMode ? <EyeOffIcon /> : <EyeIcon />}</span>
                </span>
                <span class="button-tip" aria-hidden="true">
                  {privacyToggleLabel}
                </span>
              </button>
              <button
                id="refreshViewButton"
                class="settings-btn refresh-view-btn action-btn icon-only"
                type="button"
                title={snapshot.copy.refreshPage}
                aria-label={snapshot.copy.refreshPage}
                disabled={hasGlobalPendingAction || isActionPending("refreshView")}
                aria-busy={isActionPending("refreshView")}
                onClick={() => sendAction("refreshView")}
              >
                <span class="button-face">
                  {isActionPending("refreshView") ? <span class="button-spinner" aria-hidden="true"></span> : null}
                  <span class="button-label">↻</span>
                </span>
                <span class="button-tip" aria-hidden="true">
                  {snapshot.copy.refreshPage}
                </span>
              </button>
              <button
                id="settingsOpenButton"
                class="settings-btn action-btn icon-only"
                type="button"
                title={snapshot.copy.settingsTitle}
                aria-label={snapshot.copy.settingsTitle}
                onClick={() => dispatch({ type: "open-settings" })}
              >
                <span class="button-face">
                  <span class="button-icon">⚙</span>
                </span>
                <span class="button-tip" aria-hidden="true">
                  {snapshot.copy.settingsTitle}
                </span>
              </button>
              <button
                id="aboutOpenButton"
                class="settings-btn action-btn about-btn"
                type="button"
                title={resolveAboutTitle(snapshot.lang)}
                aria-label={resolveAboutTitle(snapshot.lang)}
                onClick={() => setAboutOpen(true)}
              >
                <span class="button-face">
                  <span class="button-icon">
                    <InfoIcon />
                  </span>
                </span>
                <span class="button-tip" aria-hidden="true">
                  {resolveAboutTitle(snapshot.lang)}
                </span>
              </button>
            </div>
          </div>
          <OverviewSection
            account={overviewAccount}
            hasAccounts={snapshot.accounts.length > 0}
            lang={snapshot.lang}
            copy={snapshot.copy}
            settings={snapshot.settings}
            now={state.now}
            privacyMode={state.privacyMode}
            disabled={hasGlobalPendingAction || snapshot.indexHealth.status === "corrupted_unrecoverable"}
            addPending={prepareOAuthPending}
            importPending={isActionPending("importCurrent")}
            refreshAllPending={isActionPending("refreshAll")}
            onToggleAutoSwitchLock={handleAutoSwitchLock}
            onAddAccount={modals.openAddAccountModal}
            onImportCurrent={() => sendAction("importCurrent")}
            onRefreshAll={() => sendAction("refreshAll")}
          />
        </section>
        {snapshot.accounts.length > 0 ? (
          <section class="section">
            <div class="header" style={{ marginBottom: "12px" }}>
              <div>
                <div class="header-title header-title-with-meta" style={{ fontSize: "14px" }}>
                  {snapshot.copy.savedAccounts}
                  <span class="header-count-badge">
                    {formatSavedAccountsSummary(
                      snapshot.lang,
                      snapshot.accounts.length,
                      validAccountCount,
                      invalidAccountCount
                    )}
                  </span>
                </div>
                <div class="header-sub">{snapshot.copy.savedAccountsSub}</div>
              </div>
              {selectedCount > 0 ? (
                <BatchSelectionBar
                  copy={snapshot.copy}
                  selectedCount={selectedCount}
                  refreshPending={batchRefreshPending}
                  resyncPending={batchResyncPending}
                  removePending={batchRemovePending}
                  sharePending={sharePending}
                  tagsPending={batchTagsPending}
                  onRefresh={() => sendAction("batchRefresh", undefined, { accountIds: state.selectedAccountIds })}
                  onResync={() => {
                    setBatchSyncResult(undefined);
                    sendAction("batchResyncProfile", undefined, { accountIds: state.selectedAccountIds });
                  }}
                  onRemove={() => sendAction("batchRemove", undefined, { accountIds: state.selectedAccountIds })}
                  onShare={handleShareTokens}
                  onAddTags={() => handleBatchTagMutation("add")}
                  onRemoveTags={() => handleBatchTagMutation("remove")}
                />
              ) : null}
            </div>
            {batchSyncResult ? (
              <details class="modal-summary-card" open={batchSyncResult.failures.length > 0}>
                <summary>{snapshot.copy.batchResultTitle} · {snapshot.copy.batchResultSuccess} {batchSyncResult.successCount} · {snapshot.copy.batchResultFailed} {batchSyncResult.failedCount}
                  {batchSyncResult.partialCount ? ` · ${snapshot.copy.batchResultPartial} ${batchSyncResult.partialCount}` : ""}
                  {batchSyncResult.supersededCount ? ` · ${snapshot.copy.batchResultSuperseded} ${batchSyncResult.supersededCount}` : ""}
                </summary>
                {batchSyncResult.failures.length ? <ul>{batchSyncResult.failures.map((item, index) => (
                  <li key={`${item.accountId ?? ""}-${index}`}>
                    {item.email ? `${getSensitiveDisplayValue(item.email, state.privacyMode, "email")} · ` : ""}{item.message}
                  </li>
                ))}</ul> : null}
              </details>
            ) : null}
            <div class="accounts-grid">
              {snapshot.accounts.map((account, position) => (
                <SavedAccountCard
                  key={account.id}
                  account={account}
                  lang={snapshot.lang}
                  copy={snapshot.copy}
                  settings={snapshot.settings}
                  now={state.now}
                  privacyMode={state.privacyMode}
                  busy={isAccountBusy(account.id)}
                  reloadPromptPending={isActionPending("reloadPrompt", account.id)}
                  switchPending={isActionPending("switch", account.id)}
                  reauthorizePending={isActionPending("reauthorize", account.id)}
                  resyncProfilePending={isActionPending("resyncProfile", account.id)}
                  refreshPending={isActionPending("refresh", account.id)}
                  manualRefreshFailed={(manualRefreshFailures[account.id] ?? 0) > (account.lastQuotaAt ?? 0)}
                  detailsPending={isActionPending("details", account.id)}
                  removePending={isActionPending("remove", account.id)}
                  togglePending={isActionPending("toggleStatusBar", account.id)}
                  updateTagsPending={isActionPending("updateTags", account.id)}
                  selected={selectedAccountIds.has(account.id)}
                  previousAccountId={snapshot.accounts[position - 1]?.reorderable && account.reorderable ? snapshot.accounts[position - 1]?.id : undefined}
                  nextAccountId={snapshot.accounts[position + 1]?.reorderable && account.reorderable ? snapshot.accounts[position + 1]?.id : undefined}
                  onMove={(id, targetId, after) => sendAction("moveDashboardAccount", id, { moveTargetAccountId: targetId, moveAfter: after })}
                  onToggleSelected={() => dispatch({ type: "toggle-select", accountId: account.id })}
                  onEditTags={() => handleEditAccountTags(account)}
                  onAction={sendAction}
                  onManageResetCredits={() => resetCredits.open(account.id, resetCreditHistoryScope(account))}
                  onConfigureWakeup={() => {
                    setWakeupAccountId(account.id);
                    setWakeupResult(undefined);
                    setWakeupOpen(true);
                  }}
                />
              ))}
            </div>
          </section>
        ) : null}
      </div>

      {resetCreditsAccount && resetCreditHistory && resetCreditsScope === resetCreditHistory.scope ? (
        <ResetCreditsModal
          key={JSON.stringify([resetCreditsAccount.id, resetCreditHistory.scope])}
          account={resetCreditsAccount}
          history={resetCreditHistory}
          copy={snapshot.copy}
          lang={snapshot.lang}
          now={state.now}
          privacyMode={state.privacyMode}
          redemptionPending={isActionPending("consumeResetCredit", resetCreditsAccount.id)}
          disabled={isAccountBusy(resetCreditsAccount.id)}
          onRedeem={(creditId) => {
            const accountId = resetCreditsAccount.id;
            const requestId = sendAction("consumeResetCredit", accountId, creditId === undefined ? undefined : { resetCreditId: creditId });
            resetCredits.watchRedemption(accountId, requestId, creditId);
          }}
          onTabChange={(tab) => resetCredits.selectTab(tab)}
          onRefresh={() => resetCredits.refresh()}
          onReloadInventory={() => resetCredits.reloadInventory()}
          onLoadMore={() => resetCredits.loadMore()}
          onRetry={() => resetCredits.retry()}
          onClose={() => resetCredits.close()}
        />
      ) : null}

      {wakeupOpen ? (
        <WakeupModal
          key={wakeupAccountId ?? "all"}
          accountId={wakeupAccountId}
          lang={snapshot.lang}
          wakeup={snapshot.wakeup}
          accounts={snapshot.accounts}
          privacyMode={state.privacyMode}
          onClose={() => setWakeupOpen(false)}
          sendAction={sendAction}
          pending={state.pendingActions.some(
            (request) => request.action.includes("Wakeup") && request.action !== "runWakeupTask"
          )}
          result={wakeupResult}
        />
      ) : null}

      <SettingsOverlay
        open={state.settingsOpen}
        copy={snapshot.copy}
        lang={snapshot.lang}
        settings={snapshot.settings}
        tokenAutomation={snapshot.tokenAutomation}
        onClose={() => dispatch({ type: "close-settings" })}
        onPatchSettings={patchSettings}
        onSendSetting={sendSetting}
        onAutoRefreshToggle={handleAutoRefreshToggle}
        onAutoRefreshValue={handleAutoRefreshValue}
        onThresholdPreview={handleThresholdPreview}
        onThresholdCommit={handleThresholdCommit}
        onPickCodexAppPath={() => postMessageToHost({ type: "dashboard:pickCodexAppPath" })}
        onClearCodexAppPath={() => postMessageToHost({ type: "dashboard:clearCodexAppPath" })}
      />

      <AnnouncementCenter
        open={announcementsOpen}
        copy={snapshot.copy}
        state={snapshot.announcements}
        refreshPending={isActionPending("refreshAnnouncements")}
        markAllPending={isActionPending("markAllAnnouncementsRead")}
        onClose={() => setAnnouncementsOpen(false)}
        onAction={sendAction}
      />

      <AboutModal
        open={aboutOpen}
        lang={snapshot.lang}
        logoUri={snapshot.logoUri}
        version={packageJson.version}
        onClose={() => setAboutOpen(false)}
        onOpenExternal={(url) => sendAction("openExternalUrl", undefined, { url })}
      />

      <AddAccountModal
        open={modals.addAccountModalOpen}
        tab={modals.addAccountTab}
        copy={snapshot.copy}
        oauthSession={modals.oauthSession}
        oauthCallbackUrl={modals.oauthCallbackUrl}
        oauthError={modals.oauthError}
        deviceActive={modals.deviceActive}
        deviceGrant={modals.deviceGrant}
        deviceCancellation={modals.deviceCancellation}
        deviceBrowserFailed={modals.deviceBrowserFailed}
        onStartDevice={modals.startDevice}
        onCancelDevice={modals.cancelDevice}
        onOpenDevicePage={modals.openDevicePage}
        onCopyDeviceCode={modals.copyDeviceCode}
        onCopyDeviceLink={modals.copyDeviceLink}
        importJsonText={modals.importJsonText}
        importJsonError={modals.importJsonError}
        importPreview={modals.importPreview}
        importResult={modals.importResult}
        copyFeedbackKey={modals.copyFeedbackKey}
        lang={snapshot.lang}
        startOAuthAutoPending={startOAuthAutoPending}
        completeOAuthPending={completeOAuthPending}
        previewImportPending={previewImportPending}
        importSharedPending={importSharedPending}
        onClose={() => modals.closeAddAccountModal(completeOAuthPending)}
        onSelectTab={modals.handleAddAccountTabChange}
        onCopyOauthLink={modals.handleCopyOauthLink}
        onOpenInBrowser={modals.handleStartOAuthAutoFlow}
        onOauthCallbackChange={modals.setOauthCallbackUrl}
        onCompleteOAuth={modals.handleCompleteOAuth}
        onImportFileSelected={modals.handleImportFileSelected}
        onImportTextChange={modals.handleImportTextChange}
        onPreviewImport={modals.handlePreviewImport}
        onSubmitImport={modals.handleSubmitImport}
      />

      <ConfirmCancelOauthModal
        open={modals.confirmCancelOauthOpen}
        copy={snapshot.copy}
        onClose={modals.closeConfirmCancelOauth}
        onConfirm={modals.confirmCancelOauth}
      />

      <ShareTokenModal
        open={modals.shareModalOpen}
        copy={snapshot.copy}
        selectedCount={selectedCount}
        shareModalJson={modals.shareModalJson}
        sharePreviewExpanded={modals.sharePreviewExpanded}
        copyFeedbackKey={modals.copyFeedbackKey}
        downloadSharePending={downloadSharePending}
        onClose={modals.closeShareModal}
        onTogglePreview={modals.toggleSharePreview}
        onCopyJson={modals.handleCopyShareJson}
        onDownloadJson={modals.handleDownloadShareJson}
      />
    </>
  );
}

function resolveAboutTitle(lang: string): string {
  if (lang === "zh") {
    return "关于";
  }
  if (lang === "zh-hant") {
    return "關於";
  }
  return "About";
}

render(<App />, document.getElementById("app")!);
