import * as vscode from "vscode";
import { refreshSingleQuota } from "../../application/accounts/quota";
import { consumeResetCredit } from "../../services/quota";
import { refreshResetCreditInventory } from "../../application/accounts/resetCreditInventory";
import { probeSharedImportQuotas } from "../../application/accounts/importQuotaPreview";
import { fetchResetCreditHistory } from "../../services/resetCreditHistory";
import { getDashboardCopy } from "../../application/dashboard/copy";
import type {
  DashboardActionName,
  DashboardActionPayload,
  DashboardBatchResultFailure,
  DashboardClientMessage,
  DashboardHostMessage
} from "../../domain/dashboard/types";
import type { CodexAccountRecord } from "../../core/types";
import { getIntlLocale, type DashboardLanguage } from "../../localization/languages";
import { AccountsRepository } from "../../storage";
import { AnnouncementService, type AnnouncementOptions } from "../../services/announcements";
import { runWithConcurrencyLimit } from "../../utils/concurrency";
import { getCommandCopy, t } from "../../utils";
import { clearAutoSwitchLock, setAutoSwitchLock } from "../workbench/autoSwitchState";
import { promptForTags } from "../tagEditor";
import { parseSharedJsonInput, toFailureMessage, toImportActionPayload } from "./actionUtils";
import type { DashboardOAuthCoordinator } from "./oauthCoordinator";
import { runAuthenticatedAccountRequest } from "../../application/accounts/authenticatedAccountRequest";
import { hasPendingResetCreditRedemption, resolveResetCreditWorkspace } from "../../application/accounts/resetCreditRedemption";
import { sameAccountWorkspace } from "../../storage/accountMetadata";
import { getWakeupService } from "../workbench/wakeupRegistration";

export type DashboardActionContext = {
  context: vscode.ExtensionContext;
  repo: AccountsRepository;
  resolveLanguage: () => DashboardLanguage;
  schedulePublishState: () => void;
  publishState: (force?: boolean) => Promise<void>;
  oauth: DashboardOAuthCoordinator;
  announcements: AnnouncementService;
  getAnnouncementOptions: () => AnnouncementOptions;
};

const CODEX_BATCH_REFRESH_CONCURRENCY = 1;
const CODEX_BATCH_REFRESH_DELAY_MS = 300;

export async function executeDashboardActionMessage(
  ctx: DashboardActionContext,
  message: Extract<DashboardClientMessage, { type: "dashboard:action" }>
): Promise<{
  status: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["status"];
  payload?: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["payload"];
  errorMessage?: string;
}> {
  let status: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["status"] = "completed";
  let payload: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["payload"];
  let errorMessage: string | undefined;

  try {
    const account = message.accountId && message.action !== "previewImportSharedJson"
      ? await ctx.repo.getAccount(message.accountId) : undefined;
    payload = await runDashboardAction(ctx, message.action, message.payload, account);
  } catch (error) {
    status = "failed";
    errorMessage = toFailureMessage(error);
    console.error(`[codexAccounts] dashboard action failed: ${message.action}`, error);
  }

  return {
    status,
    payload,
    errorMessage
  };
}

async function runDashboardAction(
  ctx: DashboardActionContext,
  action: DashboardActionName,
  payload: DashboardActionPayload | undefined,
  account?: Awaited<ReturnType<AccountsRepository["getAccount"]>>
): Promise<Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["payload"] | undefined> {
  const translate = t(ctx.resolveLanguage());

  switch (action) {
    case "saveWakeupTask":
    case "removeWakeupTask":
    case "toggleWakeupTask":
    case "runWakeupTask": {
      const wakeup = getWakeupService();
      if (!wakeup) { throw new Error("Wakeup scheduler is unavailable"); }
      if (action === "saveWakeupTask") {
        if (!payload?.wakeupTask) { throw new Error("Wakeup task is required"); }
        await wakeup.saveTask(payload.wakeupTask);
      } else {
        if (typeof payload?.wakeupTaskId !== "string" || !payload.wakeupTaskId) { throw new Error("Wakeup task ID is required"); }
        if (action === "removeWakeupTask") { await wakeup.removeTask(payload.wakeupTaskId); }
        if (action === "toggleWakeupTask") {
          if (typeof payload.enabled !== "boolean") { throw new Error("Enabled state is required"); }
          await wakeup.setTaskEnabled(payload.wakeupTaskId, payload.enabled);
        }
        if (action === "runWakeupTask") { await wakeup.runNow(payload.wakeupTaskId); }
      }
      ctx.schedulePublishState();
      return undefined;
    }
    case "addAccount":
      await vscode.commands.executeCommand("codexAccounts.addAccount");
      return undefined;
    case "importCurrent":
      await vscode.commands.executeCommand("codexAccounts.importCurrentAuth");
      return undefined;
    case "refreshAll":
      await vscode.commands.executeCommand("codexAccounts.refreshAllQuotas");
      return undefined;
    case "refreshAnnouncements":
      await ctx.announcements.forceRefresh(ctx.getAnnouncementOptions());
      ctx.schedulePublishState();
      return undefined;
    case "markAnnouncementRead":
      await ctx.announcements.markAsRead(payload?.announcementId ?? "");
      ctx.schedulePublishState();
      return undefined;
    case "markAllAnnouncementsRead":
      await ctx.announcements.markAllAsRead(ctx.getAnnouncementOptions());
      ctx.schedulePublishState();
      return undefined;
    case "shareTokens":
      return handleShareTokens(ctx.repo, payload, translate);
    case "restoreFromBackup":
      return handleRestoreFromBackup(ctx.repo, ctx.schedulePublishState, translate);
    case "restoreFromAuthJson":
      return handleRestoreFromAuthJson(ctx.repo, ctx.schedulePublishState, translate);
    case "copyText":
      return handleCopyText(payload);
    case "openExternalUrl":
      return handleOpenExternalUrl(payload);
    case "downloadJsonFile":
      return handleDownloadJsonFile(ctx.context, payload);
    case "importSharedJson":
      return handleImportSharedJson(ctx.repo, ctx.schedulePublishState, payload, translate);
    case "previewImportSharedJson":
      return handlePreviewImportSharedJson(ctx.repo, payload, translate);
    case "prepareOAuthSession":
      return ctx.oauth.prepareSession(translate);
    case "prepareDeviceOAuthSession":
      return ctx.oauth.prepareDeviceSession(payload?.deviceSessionId);
    case "completeDeviceOAuthSession":
      return ctx.oauth.completeDeviceSession(payload?.deviceSessionId, translate);
    case "cancelDeviceOAuthSession":
      return { deviceOAuthCancellation: ctx.oauth.cancelDeviceSession(payload?.deviceSessionId) };
    case "cancelOAuthSession":
      ctx.oauth.cancelSession(payload?.oauthSessionId);
      return undefined;
    case "startOAuthAutoFlow":
      return ctx.oauth.startAutoFlow(payload?.oauthSessionId, translate);
    case "completeOAuthSession":
      return ctx.oauth.completeSession(payload?.oauthSessionId, payload?.callbackUrl, translate);
    case "refreshView":
      await ctx.publishState(true);
      return undefined;
    case "moveDashboardAccount":
      if (account && typeof payload?.moveTargetAccountId === "string") {
        await ctx.repo.moveDashboardAccount(account.id, payload.moveTargetAccountId, payload.moveAfter === true);
        ctx.schedulePublishState();
      }
      return undefined;
    case "updateTags":
      return handleUpdateTags(ctx.repo, ctx.resolveLanguage, ctx.schedulePublishState, payload, account, translate);
    case "setAutoSwitchLock":
      return handleAutoSwitchLock(payload, account, ctx.schedulePublishState);
    case "batchRefresh":
      return handleBatchRefresh(ctx.repo, ctx.schedulePublishState, payload, translate);
    case "batchResyncProfile":
      return handleBatchResync(ctx.repo, ctx.schedulePublishState, payload, translate);
    case "batchRemove":
      return handleBatchRemove(ctx.repo, payload, translate, ctx.schedulePublishState);
    case "reloadPrompt":
      return handleReloadPrompt(account);
    case "reauthorize":
      if (account) {
        await vscode.commands.executeCommand("codexAccounts.reauthorizeAccount", account);
      }
      return undefined;
    case "resyncProfile":
      if (account) {
        try {
          const result = await resyncAccountInfo(ctx.repo, account.id);
          if (result) {
            throw new Error(result.message);
          }
        } catch (error) {
          void vscode.window.showWarningMessage(toFailureMessage(error));
          throw error;
        } finally {
          ctx.schedulePublishState();
        }
      }
      return undefined;
    case "dismissHealthIssue":
      if (account) {
        await ctx.repo.dismissHealthIssue(account.id, payload?.issueKey);
        ctx.schedulePublishState();
      }
      return undefined;
    case "details":
      if (account) {
        await vscode.commands.executeCommand("codexAccounts.openDetails", account, {
          privacyMode: payload?.privacyMode === true
        });
      }
      return undefined;
    case "switch":
      if (account) {
        await vscode.commands.executeCommand("codexAccounts.switchAccount", account);
      }
      return undefined;
    case "refresh":
      if (account) {
        const refreshed = await vscode.commands.executeCommand<boolean>("codexAccounts.refreshQuota", account);
        if (refreshed === false) {
          throw new Error(getDashboardCopy(ctx.resolveLanguage()).quotaRefreshFailed);
        }
      }
      return undefined;
    case "remove":
      if (account) {
        await vscode.commands.executeCommand("codexAccounts.removeAccount", account);
      }
      return undefined;
    case "toggleStatusBar":
      if (account) {
        await vscode.commands.executeCommand("codexAccounts.toggleStatusBarAccount", account);
      }
      return undefined;
    case "getResetCredits":
      return handleGetResetCredits(ctx.repo, account, ctx.schedulePublishState);
    case "getResetCreditHistory":
      return handleGetResetCreditHistory(ctx.repo, account, payload?.resetCreditHistoryCursor);
    case "getLocalResetCreditHistory": {
      if (!account) {
        throw new Error("Account not found");
      }
      const tokens = await ctx.repo.getTokens(account.id, { syncExternal: false });
      const latest = await ctx.repo.getAccount(account.id);
      if (!latest || !sameAccountWorkspace(account, latest)) {
        throw new Error("Codex workspace changed while reading local reset credit history");
      }
      const scope = tokens ? resolveResetCreditWorkspace(latest, tokens) : latest;
      return { localResetCreditHistory: (latest.resetCreditLocalHistory ?? [])
        .filter((row) => sameAccountWorkspace(row, scope)).reverse()
        .map(({ requestId, occurredAt, outcome }) => ({ requestId, occurredAt, outcome })) };
    }
    case "consumeResetCredit":
      return handleConsumeResetCredit(ctx.repo, account, ctx.schedulePublishState, ctx.resolveLanguage(), payload?.resetCreditId);
    default:
      return undefined;
  }
}

async function handleShareTokens(
  repo: AccountsRepository,
  payload: DashboardActionPayload | undefined,
  translate: ReturnType<typeof t>
) {
  try {
    const accountIds = payload?.accountIds ?? [];
    const shared = await repo.exportSharedAccounts(accountIds);
    if (shared.length === 0) {
      const message = translate("message.shareTokensFailed", { message: "No accounts selected" });
      void vscode.window.showErrorMessage(message);
      throw new Error(message);
    }

    void vscode.window.showInformationMessage(
      translate("message.shareTokensReady", {
        count: shared.length
      })
    );
    return {
      sharedJson: JSON.stringify(shared, null, 2)
    };
  } catch (error) {
    const message = translate("message.shareTokensFailed", {
      message: toFailureMessage(error)
    });
    void vscode.window.showErrorMessage(message);
    throw new Error(message, { cause: error });
  }
}

async function handleRestoreFromBackup(
  repo: AccountsRepository,
  schedulePublishState: () => void,
  translate: ReturnType<typeof t>
) {
  try {
    const restored = await repo.restoreIndexFromLatestBackup();
    schedulePublishState();
    void vscode.window.showInformationMessage(
      translate("message.restoreFromBackupSuccess", {
        count: restored.restoredCount
      })
    );
    return {
      restoredCount: restored.restoredCount
    };
  } catch (error) {
    const message = translate("message.restoreFromBackupFailed", {
      message: toFailureMessage(error)
    });
    void vscode.window.showErrorMessage(message);
    throw new Error(message, { cause: error });
  }
}

async function handleRestoreFromAuthJson(
  repo: AccountsRepository,
  schedulePublishState: () => void,
  translate: ReturnType<typeof t>
) {
  try {
    const restored = await repo.restoreAccountsFromAuthFile();
    schedulePublishState();
    void vscode.window.showInformationMessage(
      translate("message.restoreFromAuthSuccess", {
        count: restored.restoredCount
      })
    );
    return {
      restoredCount: restored.restoredCount
    };
  } catch (error) {
    const message = translate("message.restoreFromAuthFailed", {
      message: toFailureMessage(error)
    });
    void vscode.window.showErrorMessage(message);
    throw new Error(message, { cause: error });
  }
}

async function handleCopyText(payload: DashboardActionPayload | undefined) {
  const text = payload?.text ?? "";
  if (!text) {
    return undefined;
  }
  await vscode.env.clipboard.writeText(text);
  return undefined;
}

async function handleOpenExternalUrl(payload: DashboardActionPayload | undefined) {
  const url = payload?.url?.trim();
  if (!url) {
    return undefined;
  }
  const externalUrlOpened = await vscode.env.openExternal(vscode.Uri.parse(url));
  return { externalUrlOpened };
}

async function handleDownloadJsonFile(
  context: vscode.ExtensionContext,
  payload: DashboardActionPayload | undefined
) {
  const text = payload?.text ?? "";
  const defaultName = payload?.filename?.trim() ?? "codex-accounts-manager-share.json";
  if (!text) {
    return undefined;
  }

  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(context.globalStorageUri, defaultName),
    filters: {
      JSON: ["json"]
    },
    saveLabel: "Save JSON"
  });
  if (!target) {
    return undefined;
  }

  await vscode.workspace.fs.writeFile(target, Buffer.from(text, "utf8"));
  return undefined;
}

async function handleImportSharedJson(
  repo: AccountsRepository,
  schedulePublishState: () => void,
  payload: DashboardActionPayload | undefined,
  translate: ReturnType<typeof t>
) {
  let parsed: ReturnType<typeof parseSharedJsonInput>;
  try {
    parsed = parseSharedJsonInput(payload?.jsonText ?? "", (message) =>
      translate("message.sharedJsonParseFailed", { message })
    );
  } catch (error) {
    const message = toFailureMessage(error);
    void vscode.window.showErrorMessage(message);
    throw error;
  }

  try {
    const result = payload?.recoveryMode
      ? await repo.restoreAccountsFromSharedJson(parsed)
      : await repo.importSharedAccountsWithSummary(parsed);
    schedulePublishState();
    void vscode.window.showInformationMessage(
      translate(payload?.recoveryMode ? "message.restoreFromSharedSuccess" : "message.importSharedJsonSuccess", {
        count: "successCount" in result ? result.successCount : result.restoredCount
      })
    );
    return toImportActionPayload(result);
  } catch (error) {
    const message = translate(payload?.recoveryMode ? "message.restoreFromSharedFailed" : "message.importSharedJsonFailed", {
      message: toFailureMessage(error)
    });
    void vscode.window.showErrorMessage(message);
    throw new Error(message, { cause: error });
  }
}

async function handlePreviewImportSharedJson(
  repo: AccountsRepository,
  payload: DashboardActionPayload | undefined,
  translate: ReturnType<typeof t>
) {
  const jsonText = payload?.jsonText?.trim();
  if (!jsonText) {
    return {
      importPreview: {
        total: 0,
        valid: 0,
        overwriteCount: 0,
        invalidCount: 0,
        invalidEntries: []
      }
    };
  }

  const parsed = parseSharedJsonInput(jsonText, (message) => translate("message.sharedJsonParseFailed", { message }));
  const importPreview = await repo.previewSharedAccountsImport(parsed);
  if (Array.isArray(payload?.probeImportIndexes) && payload.probeImportIndexes.length > 0) {
    importPreview.quotaProbes = await probeSharedImportQuotas(parsed, payload.probeImportIndexes,
      importPreview.validEntries?.map((entry) => entry.index) ?? []);
  }
  return { importPreview };
}

async function handleUpdateTags(
  repo: AccountsRepository,
  resolveLanguage: () => DashboardLanguage,
  schedulePublishState: () => void,
  payload: DashboardActionPayload | undefined,
  account: CodexAccountRecord | undefined,
  translate: ReturnType<typeof t>
) {
  const targetIds = payload?.accountIds?.length ? payload.accountIds : account ? [account.id] : [];
  if (!targetIds.length) {
    return undefined;
  }
  const dashboardCopy = getDashboardCopy(resolveLanguage());
  const targetAccount = targetIds.length === 1 ? account ?? (await repo.getAccount(targetIds[0]!)) : undefined;
  const mode = payload?.mode === "add" || payload?.mode === "remove" ? payload.mode : "set";
  const tags = await promptForTags({
    copy: dashboardCopy,
    mode,
    initialTags: targetAccount?.tags ?? [],
    label: targetIds.length === 1 ? targetAccount?.email : undefined
  });
  if (tags === undefined) {
    return undefined;
  }

  if (mode === "add") {
    await repo.addAccountTags(targetIds, tags);
  } else if (mode === "remove") {
    await repo.removeAccountTags(targetIds, tags);
  } else if (targetIds.length === 1) {
    await repo.setAccountTags(targetIds[0]!, tags);
  } else {
    await repo.addAccountTags(targetIds, tags);
  }
  schedulePublishState();
  void vscode.window.showInformationMessage(
    translate("message.batchTagsSummary", {
      count: targetIds.length,
      action:
        mode === "add"
          ? dashboardCopy.addTagsBtn
          : mode === "remove"
            ? dashboardCopy.removeTagsBtn
            : dashboardCopy.editTagsBtn
    })
  );
  return undefined;
}

function handleAutoSwitchLock(
  payload: DashboardActionPayload | undefined,
  account: CodexAccountRecord | undefined,
  schedulePublishState: () => void
) {
  const lockAccountId = account?.id ?? payload?.accountIds?.[0];
  const lockMinutes = typeof payload?.lockMinutes === "number" ? payload.lockMinutes : 0;
  if (!lockAccountId) {
    return undefined;
  }

  if (lockMinutes > 0) {
    setAutoSwitchLock(lockAccountId, lockMinutes);
  } else {
    clearAutoSwitchLock(lockAccountId);
  }
  schedulePublishState();
  return undefined;
}

async function handleBatchRefresh(
  repo: AccountsRepository,
  schedulePublishState: () => void,
  payload: DashboardActionPayload | undefined,
  translate: ReturnType<typeof t>
) {
  const targetIds = payload?.accountIds ?? [];
  const accountsById = new Map(await Promise.all(targetIds.map(async (id) => [id, await repo.getAccount(id)] as const)));
  let success = 0;
  let failed = 0;
  const failures: DashboardBatchResultFailure[] = [];
  await runWithConcurrencyLimit(
    targetIds,
    CODEX_BATCH_REFRESH_CONCURRENCY,
    async (id) => {
      try {
        await refreshSingleQuota(repo, { refresh() {} }, id, {
          announce: false,
          forceRefresh: true,
          refreshView: false,
          throwOnFailure: true,
          warnQuota: false
        });
        success += 1;
      } catch (error) {
        failed += 1;
        failures.push({
          accountId: id,
          email: accountsById.get(id)?.email,
          message: toFailureMessage(error)
        });
        console.warn(`[codexAccounts] batch quota refresh failed for ${id}:`, error);
      }
    },
    { delayMs: CODEX_BATCH_REFRESH_DELAY_MS }
  );
  schedulePublishState();
  const message = translate("message.batchRefreshSummary", {
    success,
    failed
  });
  if (failed > 0) {
    void vscode.window.showWarningMessage(message);
  } else {
    void vscode.window.showInformationMessage(message);
  }
  return {
    batchResult: {
      kind: "batch_refresh" as const,
      successCount: success,
      failedCount: failed,
      failures
    }
  };
}

async function handleBatchResync(
  repo: AccountsRepository,
  schedulePublishState: () => void,
  payload: DashboardActionPayload | undefined,
  translate: ReturnType<typeof t>
) {
  const targetIds = payload?.accountIds ?? [];
  const accountsById = new Map(await Promise.all(targetIds.map(async (id) => [id, await repo.getAccount(id)] as const)));
  let success = 0;
  let failed = 0;
  let partial = 0;
  let superseded = 0;
  const failures: DashboardBatchResultFailure[] = [];
  await runWithConcurrencyLimit(targetIds, 4, async (id) => {
    try {
      const result = await resyncAccountInfo(repo, id);
      if (result) {
        if (result.outcome === "superseded") {
          superseded += 1;
        } else {
          partial += 1;
        }
        failures.push({ accountId: id, email: accountsById.get(id)?.email, ...result });
      } else {
        success += 1;
      }
    } catch (error) {
      failed += 1;
      failures.push({
        accountId: id,
        email: accountsById.get(id)?.email,
        message: toFailureMessage(error)
      });
      console.warn(`[codexAccounts] batch profile resync failed for ${id}:`, error);
    }
  }, { delayMs: CODEX_BATCH_REFRESH_DELAY_MS });
  schedulePublishState();
  const message = translate(partial || superseded ? "message.batchResyncDetailedSummary" : "message.batchResyncSummary", {
    success,
    failed,
    partial,
    superseded
  });
  if (failures.length) {
    const reason = failures[0]?.message;
    void vscode.window.showWarningMessage(reason ? `${message} ${reason}` : message);
  } else {
    void vscode.window.showInformationMessage(message);
  }
  return {
    batchResult: {
      kind: "batch_resync" as const,
      successCount: success,
      failedCount: failed,
      ...(partial ? { partialCount: partial } : {}),
      ...(superseded ? { supersededCount: superseded } : {}),
      failures
    }
  };
}

async function resyncAccountInfo(repo: AccountsRepository, accountId: string): Promise<Pick<DashboardBatchResultFailure, "outcome" | "message"> | undefined> {
  await repo.refreshAccountProfileMetadata(accountId);
  try {
    await refreshSingleQuota(repo, { refresh() {} }, accountId, {
      announce: false, awaitSubscriptionRefresh: true, forceRefresh: true,
      refreshView: false, warnQuota: false, throwOnFailure: true
    });
  } catch (error) {
    const cause = error instanceof Error ? error.cause as CodexAccountRecord["quotaError"] : undefined;
    return { outcome: cause?.code === "quota_refresh_superseded" ? "superseded" : "partial", message: toFailureMessage(error) };
  }
  const latest = await repo.getAccount(accountId);
  return latest?.subscriptionQueryLastError ? { outcome: "partial", message: latest.subscriptionQueryLastError } : undefined;
}

async function handleBatchRemove(
  repo: AccountsRepository,
  payload: DashboardActionPayload | undefined,
  translate: ReturnType<typeof t>,
  schedulePublishState: () => void
) {
  const targetIds = payload?.accountIds ?? [];
  if (!targetIds.length) {
    return undefined;
  }
  const accountsById = new Map(await Promise.all(targetIds.map(async (id) => [id, await repo.getAccount(id)] as const)));
  const choice = await vscode.window.showWarningMessage(
    translate("message.batchRemoveConfirm", { count: targetIds.length }),
    { modal: true },
    translate("confirm.removeButton")
  );
  if (choice !== translate("confirm.removeButton")) {
    return undefined;
  }
  let removed = 0;
  let failed = 0;
  const failures: DashboardBatchResultFailure[] = [];
  for (const id of targetIds) {
    try {
      await repo.removeAccount(id);
      removed += 1;
    } catch (error) {
      failed += 1;
      failures.push({
        accountId: id,
        email: accountsById.get(id)?.email,
        message: toFailureMessage(error)
      });
      console.warn(`[codexAccounts] batch remove failed for ${id}:`, error);
    }
  }
  schedulePublishState();
  const message = translate("message.batchRemoveSummary", {
    count: removed,
    failed
  });
  if (failed > 0) {
    void vscode.window.showWarningMessage(message);
  } else {
    void vscode.window.showInformationMessage(message);
  }
  return {
    batchResult: {
      kind: "batch_remove" as const,
      successCount: removed,
      failedCount: failed,
      failures
    }
  };
}

async function handleReloadPrompt(account: CodexAccountRecord | undefined) {
  if (account) {
    const copy = getCommandCopy();
    const choice = await vscode.window.showInformationMessage(
      copy.switchedAndAskReload(account.email),
      copy.reloadNow,
      copy.later
    );
    if (choice === copy.reloadNow) {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  }
  return undefined;
}

async function handleGetResetCredits(
  repo: AccountsRepository,
  account?: CodexAccountRecord,
  schedulePublishState?: () => void
) {
  if (!account) {
    throw new Error("Account not found");
  }

  const snapshot = await refreshResetCreditInventory(repo, account, { force: true });
  schedulePublishState?.();
  return { resetCredits: snapshot };
}

async function handleGetResetCreditHistory(
  repo: AccountsRepository,
  account: CodexAccountRecord | undefined,
  cursor?: string
) {
  if (!account) {
    throw new Error("Account not found");
  }
  if (cursor !== undefined && typeof cursor !== "string") {
    throw new Error("Invalid reset credit history cursor");
  }

  let requestedWorkspace: ReturnType<typeof resolveResetCreditWorkspace> | undefined;
  const resetCreditHistory = await runAuthenticatedAccountRequest(repo, account.id, async (tokens) => {
    const latest = await repo.getAccount(account.id);
    if (!latest || !sameAccountWorkspace(account, latest)) {
      throw new Error("Codex workspace changed while reading reset credit history");
    }
    const workspace = resolveResetCreditWorkspace(latest, tokens);
    if (requestedWorkspace && !sameAccountWorkspace(requestedWorkspace, workspace)) {
      throw new Error("Codex credentials changed workspace while reading reset credit history");
    }
    requestedWorkspace = workspace;
    return fetchResetCreditHistory(tokens.accessToken, workspace.accountId, cursor);
  });

  const latest = await repo.getAccount(account.id);
  if (!latest || !sameAccountWorkspace(account, latest)) {
    throw new Error("Codex workspace changed while reading reset credit history");
  }
  return { resetCreditHistory };
}

async function handleConsumeResetCredit(
  repo: AccountsRepository,
  account: CodexAccountRecord | undefined,
  schedulePublishState: () => void,
  lang: DashboardLanguage,
  creditId?: string
) {
  if (!account) {
    throw new Error("Account not found");
  }

  const retry = hasPendingResetCreditRedemption(account);
  const available = account.quotaSummary?.resetCreditsAvailable ?? account.resetCreditInventory?.snapshot?.availableCount ?? 0;
  if (creditId !== undefined && (typeof creditId !== "string" || !creditId.trim())) {
    throw new Error("Invalid reset credit ID.");
  }
  if (retry && creditId !== undefined && account.resetCreditRedemption?.creditId !== creditId) {
    throw new Error("Confirm the previous reset before using another credit.");
  }
  if (!retry && creditId === undefined && available <= 0) {
    throw new Error("No reset credits available");
  }

  const isZh = lang.startsWith("zh");
  const title = retry
    ? isZh ? "确认上次重置结果？" : "Confirm the previous reset?"
    : isZh ? "要重置你的使用量吗？" : "Reset your usage?";
  let body = retry
    ? isZh ? "将使用原兑换请求确认结果。" : "The original redemption request will be retried."
    : isZh ? `你还有 ${available} 次重置可用。` : `You have ${available} reset(s) available.`;
  if (!retry && creditId !== undefined) {
    body = isZh ? "将使用你选择的重置卡。" : "The selected reset credit will be used.";
    const selected = account.resetCreditInventory?.snapshot?.credits.find((credit) => credit.id === creditId);
    const expiration = new Date((selected?.expires_at ?? NaN) * 1000);
    if (Number.isFinite(expiration.getTime())) {
      const formatted = new Intl.DateTimeFormat(getIntlLocale(lang), { dateStyle: "medium", timeStyle: "short" }).format(expiration);
      body = isZh ? `将使用 ${formatted} 到期的重置卡。` : `The reset credit expiring on ${formatted} will be used.`;
    }
  }
  const confirmBtn = retry
    ? isZh ? "确认上次重置" : "Confirm Previous Reset"
    : isZh ? "重置速率限制" : "Reset Rate Limit";

  const choice = await vscode.window.showWarningMessage(
    `${title}\n\n${body}`,
    { modal: true },
    confirmBtn
  );
  if (choice !== confirmBtn) {
    return undefined;
  }

  let submitted = false;
  let outcome: Awaited<ReturnType<typeof consumeResetCredit>>;
  try {
    const initialTokens = await repo.getFreshTokens(account.id);
    if (!initialTokens?.accessToken) {
      throw new Error("No access token available");
    }
    const workspace = resolveResetCreditWorkspace(account, initialTokens);
    outcome = await repo.redeemResetCredit(account, workspace, (requestId, selectedCreditId) => {
      schedulePublishState();
      return runAuthenticatedAccountRequest(repo, account.id, async (tokens) => {
        const latest = await repo.getAccount(account.id);
        if (!latest || !sameAccountWorkspace(workspace, resolveResetCreditWorkspace(latest, tokens))) {
          throw new Error("Codex workspace changed during reset credit redemption");
        }
        submitted = true;
        return consumeResetCredit(tokens.accessToken, workspace.accountId, requestId, selectedCreditId);
      }, initialTokens);
    }, creditId);
  } catch (error) {
    const message = submitted
      ? isZh ? "重置结果待确认。再次确认时会使用同一个兑换请求。"
        : "The reset result is unconfirmed. Retrying will reuse the same redemption request."
      : toFailureMessage(error);
    void vscode.window.showWarningMessage(message);
    throw new Error(message, { cause: error });
  } finally {
    schedulePublishState();
  }

  const redeemed = outcome === "reset" || outcome === "already_redeemed";
  if (redeemed) {
    void vscode.window.showInformationMessage(
      isZh ? "速率限制已重置，你可以继续工作了。" : "Rate limit has been reset. You can continue working."
    );
  } else {
    const message = outcome === "no_credit"
      ? isZh ? "没有可用的重置卡。" : "No reset credits are available."
      : isZh ? "当前额度无需重置。" : "The rate limit does not need to be reset.";
    void vscode.window.showWarningMessage(message);
  }
  let resetCredits: Awaited<ReturnType<typeof refreshResetCreditInventory>>;
  try {
    resetCredits = await refreshResetCreditInventory(repo, account, { force: true });
    schedulePublishState();
  } catch {
    console.warn("[codexAccounts] refresh reset credit inventory after redemption failed");
  }
  try {
    await vscode.commands.executeCommand("codexAccounts.refreshQuota", account);
  } catch (error) {
    console.warn("[codexAccounts] refresh quota after consuming reset credit failed:", error);
  }
  return redeemed || resetCredits ? { resetCredits, resetCreditHistoryChanged: redeemed ? true as const : undefined } : undefined;
}
