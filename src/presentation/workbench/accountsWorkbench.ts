import * as path from "path";
import * as vscode from "vscode";
import { refreshImportedAccountQuota, registerCommands } from "../../commands";
import { getAuthJsonPath, readAuthFile } from "../../codex";
import { needsRefresh, refreshTokens } from "../../auth/oauth";
import { AccountsRepository } from "../../storage";
import { refreshQuotaSummaryPanel } from "../dashboard";
import { AccountsStatusBarProvider, refreshDetailsPanel } from "../../ui";
import { getExternalAuthSyncCopy, getLocalAccountCopy, registerDebugOutput } from "../../utils";
import { getErrorMessage } from "../../core";
import { readCurrentAuthAccountStorageId } from "../../utils/accountIdentity";
import { needsWindowReloadForAccount, setCurrentWindowRuntimeAccountId } from "./windowRuntimeAccount";

const TOKEN_REFRESH_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const TOKEN_REFRESH_SKEW_SECONDS = 10 * 60;

export class AccountsWorkbench {
  private readonly repo: AccountsRepository;
  private readonly statusBar: AccountsStatusBarProvider;
  private lastObservedAuthIdentity?: string;
  private lastRefreshSignature?: string;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.repo = new AccountsRepository(context);
    this.statusBar = new AccountsStatusBarProvider(context, this.repo);
  }

  async activate(): Promise<void> {
    registerDebugOutput(this.context);
    await this.repo.init();
    this.lastObservedAuthIdentity = await this.readObservedAuthIdentity();
    setCurrentWindowRuntimeAccountId(this.lastObservedAuthIdentity);
    this.context.subscriptions.push({ dispose: () => this.repo.dispose() });
    let refreshTimer: NodeJS.Timeout | undefined;

    const flushRefresh = (): void => {
      refreshTimer = undefined;
      void this.refreshViewsIfNeeded();
    };

    const refreshers = {
      refresh: (): void => {
        if (refreshTimer) {
          return;
        }
        refreshTimer = setTimeout(flushRefresh, 0);
      },
      markObservedAuthIdentity: (accountId?: string): void => {
        this.lastObservedAuthIdentity = accountId;
      }
    };

    this.context.subscriptions.push({
      dispose(): void {
        if (refreshTimer) {
          clearTimeout(refreshTimer);
          refreshTimer = undefined;
        }
      }
    });

    registerCommands(this.context, this.repo, refreshers);
    this.registerAuthFileWatcher(refreshers);
    this.registerAutoRefreshScheduler();
    this.registerTokenRefreshScheduler(refreshers);
    await this.promptImportCurrentAccountIfNeeded(refreshers);
    await this.statusBar.refresh();
  }

  dispose(): void {
    this.repo.dispose();
  }

  private async refreshViewsIfNeeded(): Promise<void> {
    const signature = await this.buildRefreshSignature();
    if (signature === this.lastRefreshSignature) {
      return;
    }

    this.lastRefreshSignature = signature;
    await Promise.all([
      this.statusBar.refresh(),
      refreshDetailsPanel(),
      refreshQuotaSummaryPanel()
    ]);
  }

  private async promptImportCurrentAccountIfNeeded(view: { refresh(): void }): Promise<void> {
    const accounts = await this.repo.listAccounts();
    if (accounts.length > 0 && accounts.some((account) => account.isActive)) {
      return;
    }

    await this.promptImportCurrentAccount(view);
  }

  private async promptImportCurrentAccount(view: { refresh(): void }): Promise<void> {
    const auth = await readAuthFile();
    if (!auth?.tokens?.id_token || !auth.tokens.access_token) {
      return;
    }

    const copy = getLocalAccountCopy();
    const choice = await vscode.window.showInformationMessage(copy.message, copy.action);
    if (choice !== copy.action) {
      return;
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: copy.title,
          cancellable: false
        },
        async () => {
          const account = await this.repo.importCurrentAuth();
          this.lastObservedAuthIdentity = account.id;
          const result = await refreshImportedAccountQuota(this.repo, account.id);
          view.refresh();

          if (result.error) {
            void vscode.window.showWarningMessage(copy.partial(account.email, result.error.message));
          } else {
            void vscode.window.showInformationMessage(copy.success(account.email));
          }
        }
      );
    } catch (error) {
      void vscode.window.showErrorMessage(copy.failed(getErrorMessage(error)));
    }
  }

  private registerAuthFileWatcher(view: { refresh(): void }): void {
    const authPath = getAuthJsonPath();
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(path.dirname(authPath), path.basename(authPath))
    );

    let syncTimer: NodeJS.Timeout | undefined;
    let promptVisible = false;

    const scheduleSync = (): void => {
      if (syncTimer) {
        clearTimeout(syncTimer);
      }

      syncTimer = setTimeout(() => {
        void this.syncActiveAccountFromExternalChange(
          view,
          () => {
            promptVisible = true;
          },
          () => {
            promptVisible = false;
          },
          () => promptVisible
        );
      }, 300);
    };

    watcher.onDidChange(scheduleSync, null, this.context.subscriptions);
    watcher.onDidCreate(scheduleSync, null, this.context.subscriptions);
    watcher.onDidDelete(scheduleSync, null, this.context.subscriptions);
    this.context.subscriptions.push(watcher, {
      dispose(): void {
        if (syncTimer) {
          clearTimeout(syncTimer);
        }
      }
    });
  }

  private async syncActiveAccountFromExternalChange(
    view: { refresh(): void },
    markVisible: () => void,
    markHidden: () => void,
    isVisible: () => boolean
  ): Promise<void> {
    const previousObservedIdentity = this.lastObservedAuthIdentity;
    const nextObservedIdentity = await this.readObservedAuthIdentity();
    this.lastObservedAuthIdentity = nextObservedIdentity;

    await this.repo.syncActiveAccountFromAuthFile();
    view.refresh();

    const afterAccounts = await this.repo.listAccounts();
    const nextActive = afterAccounts.find((account) => account.isActive);

    if (isVisible()) {
      return;
    }

    try {
      if (!nextActive && afterAccounts.length > 0) {
        if (previousObservedIdentity === nextObservedIdentity) {
          return;
        }
        markVisible();
        await this.promptImportCurrentAccount(view);
        return;
      }

      if (!nextActive || previousObservedIdentity === nextObservedIdentity) {
        return;
      }

      if (!needsWindowReloadForAccount(nextActive.id)) {
        return;
      }

      const copy = getExternalAuthSyncCopy();
      markVisible();

      const choice = await vscode.window.showInformationMessage(
        copy.message(nextActive.accountName ?? nextActive.email),
        copy.reloadNow,
        copy.later
      );

      if (choice === copy.reloadNow) {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    } finally {
      markHidden();
    }
  }

  private async readObservedAuthIdentity(): Promise<string | undefined> {
    return readCurrentAuthAccountStorageId();
  }

  private async buildRefreshSignature(): Promise<string> {
    const accounts = await this.repo.listAccounts();
    return JSON.stringify({
      observed: this.lastObservedAuthIdentity,
      accounts: accounts.map((account) => ({
        id: account.id,
        email: account.email,
        accountName: account.accountName,
        planType: account.planType,
        accountId: account.accountId,
        organizationId: account.organizationId,
        userId: account.userId,
        isActive: account.isActive,
        showInStatusBar: Boolean(account.showInStatusBar),
        lastQuotaAt: account.lastQuotaAt,
        updatedAt: account.updatedAt,
        quotaError: account.quotaError
          ? {
              code: account.quotaError.code,
              message: account.quotaError.message,
              timestamp: account.quotaError.timestamp
            }
          : undefined,
        quotaSummary: account.quotaSummary
          ? {
              hourlyPercentage: account.quotaSummary.hourlyPercentage,
              hourlyResetTime: account.quotaSummary.hourlyResetTime,
              hourlyWindowMinutes: account.quotaSummary.hourlyWindowMinutes,
              hourlyWindowPresent: account.quotaSummary.hourlyWindowPresent,
              weeklyPercentage: account.quotaSummary.weeklyPercentage,
              weeklyResetTime: account.quotaSummary.weeklyResetTime,
              weeklyWindowMinutes: account.quotaSummary.weeklyWindowMinutes,
              weeklyWindowPresent: account.quotaSummary.weeklyWindowPresent,
              codeReviewPercentage: account.quotaSummary.codeReviewPercentage,
              codeReviewResetTime: account.quotaSummary.codeReviewResetTime,
              codeReviewWindowMinutes: account.quotaSummary.codeReviewWindowMinutes,
              codeReviewWindowPresent: account.quotaSummary.codeReviewWindowPresent
            }
          : undefined
      }))
    });
  }

  private registerAutoRefreshScheduler(): void {
    let timer: NodeJS.Timeout | undefined;

    const applySchedule = (): void => {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }

      const minutes = vscode.workspace.getConfiguration("codexAccounts").get<number>("autoRefreshMinutes", 0);
      if (!minutes || minutes <= 0) {
        return;
      }

      const runAutoRefresh = (): void => {
        void vscode.commands.executeCommand("codexAccounts.refreshAllQuotas", {
          silent: true,
          forceRefresh: true
        });
      };

      timer = setInterval(runAutoRefresh, minutes * 60 * 1000);
      runAutoRefresh();
    };

    applySchedule();

    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("codexAccounts.autoRefreshMinutes")) {
          applySchedule();
        }
      }),
      {
        dispose(): void {
          if (timer) {
            clearInterval(timer);
          }
        }
      }
    );
  }

  private registerTokenRefreshScheduler(view: { refresh(): void }): void {
    let timer: NodeJS.Timeout | undefined;
    let inFlight = false;

    const runTokenRefreshSweep = async (): Promise<void> => {
      if (inFlight) {
        return;
      }

      inFlight = true;
      try {
        const accounts = await this.repo.listAccounts();
        for (const account of accounts) {
          try {
            const tokens = await this.repo.getTokens(account.id);
            if (!tokens?.accessToken || !tokens.refreshToken || !needsRefresh(tokens.accessToken, TOKEN_REFRESH_SKEW_SECONDS)) {
              continue;
            }

            const refreshed = await refreshTokens(tokens.refreshToken);
            await this.repo.updateTokens(account.id, {
              ...refreshed,
              accountId: refreshed.accountId ?? account.accountId ?? tokens.accountId
            });
          } catch (error) {
            console.warn(`[codexAccounts] background token refresh failed for ${account.email}:`, error);
          }
        }
      } finally {
        inFlight = false;
        view.refresh();
      }
    };

    timer = setInterval(() => {
      void runTokenRefreshSweep();
    }, TOKEN_REFRESH_CHECK_INTERVAL_MS);
    void runTokenRefreshSweep();

    this.context.subscriptions.push({
      dispose(): void {
        if (timer) {
          clearInterval(timer);
        }
      }
    });
  }
}
