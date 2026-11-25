import * as vscode from "vscode";
import { needsRefresh } from "../../auth/oauth";
import { getAutoRefreshMinutes, getCodexAccountsConfiguration, isBackgroundTokenRefreshEnabled, readAutoRefreshPlanTypes } from "../../infrastructure/config/extensionSettings";
import { AUTO_REFRESH_PLANS } from "../../domain/dashboard/types";
import type { AccountsRepository } from "../../storage";
import { shouldRunAccountScheduler } from "./refreshSignature";
import {
  clearTokenAutomationError,
  configureTokenAutomation,
  markTokenAutomationCheck,
  markTokenAutomationRefreshFailure,
  markTokenAutomationRefreshSuccess,
  markTokenAutomationSweepFinished,
  markTokenAutomationSweepStarted
} from "./tokenAutomationState";

export function registerAutoRefreshScheduler(params: {
  context: vscode.ExtensionContext;
  repo: AccountsRepository;
  onRefresh: () => void;
}): vscode.Disposable {
  let timer: NodeJS.Timeout | undefined;
  let inFlight = false;
  let disposed = false;

  const runAutoRefresh = async (): Promise<void> => {
    if (inFlight || !timer) {
      return;
    }

    inFlight = true;
    try {
      const accounts = await params.repo.listAccounts();
      if (timer && shouldRunAccountScheduler(accounts.length)) {
        await params.repo.runBackgroundQuotaBatch(async () => {
          if (!timer) {
            return;
          }
          const plans = readAutoRefreshPlanTypes(getCodexAccountsConfiguration().get<unknown>("autoRefreshPlanTypes"));
          await vscode.commands.executeCommand("codexAccounts.refreshAllQuotas", {
            silent: true,
            forceRefresh: true,
            ...(plans.length !== AUTO_REFRESH_PLANS.length ? { backgroundPlanTypes: plans } : {})
          });
        });
      }
    } catch (error) {
      console.warn("[codexAccounts] background quota refresh failed:", error);
    } finally {
      inFlight = false;
    }
  };

  const applySchedule = (): void => {
    if (disposed) {
      return;
    }
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }

    const minutes = getAutoRefreshMinutes();
    if (!minutes || minutes <= 0) {
      return;
    }

    timer = setInterval(() => { void runAutoRefresh(); }, minutes * 60 * 1000);
    void runAutoRefresh();
  };

  applySchedule();

  const configDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("codexAccounts.autoRefreshMinutes")) {
      applySchedule();
    }
  });

  params.context.subscriptions.push(configDisposable);
  return {
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      configDisposable.dispose();
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    }
  };
}

export function registerTokenRefreshScheduler(params: {
  context: vscode.ExtensionContext;
  repo: AccountsRepository;
  view: { refresh(): void };
  checkIntervalMs: number;
  skewSeconds: number;
}): vscode.Disposable {
  let timer: NodeJS.Timeout | undefined;
  let inFlight = false;

  const runTokenRefreshSweep = async (): Promise<void> => {
    if (inFlight) {
      return;
    }

    inFlight = true;
    let lastFailureMessage: string | undefined;
    let checked = 0;
    let refreshedCount = 0;
    try {
      markTokenAutomationSweepStarted();
      const accounts = await params.repo.listAccounts();
      if (!shouldRunAccountScheduler(accounts.length)) {
        return;
      }

      for (const account of accounts) {
        try {
          const tokens = await params.repo.getTokens(account.id);
          markTokenAutomationCheck(account.id);
          checked += 1;
          if (!tokens?.accessToken || !needsRefresh(tokens.accessToken, params.skewSeconds)) {
            clearTokenAutomationError(account.id);
            continue;
          }

          if (!tokens.refreshToken) {
            throw new Error("Token expired and no refresh token is available");
          }

          await params.repo.getFreshTokens(account.id, { skewSeconds: params.skewSeconds });
          markTokenAutomationRefreshSuccess(account.id);
          refreshedCount += 1;
        } catch (error) {
          lastFailureMessage = error instanceof Error ? error.message : String(error);
          markTokenAutomationRefreshFailure(account.id, lastFailureMessage);
          console.warn(`[codexAccounts] background token refresh failed for ${account.email}:`, error);
        }
      }
    } finally {
      inFlight = false;
      markTokenAutomationSweepFinished(lastFailureMessage);
      console.info(
        `[codexAccounts] background token refresh sweep: checked=${checked}, refreshed=${refreshedCount}` +
          (lastFailureMessage ? `, lastError=${lastFailureMessage}` : ""),
        { checked, refreshed: refreshedCount }
      );
      params.view.refresh();
    }
  };

  const applySchedule = (): void => {
    const enabled = isBackgroundTokenRefreshEnabled();
    configureTokenAutomation(enabled, params.checkIntervalMs, params.skewSeconds);

    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }

    if (!enabled) {
      params.view.refresh();
      return;
    }

    timer = setInterval(() => {
      void runTokenRefreshSweep();
    }, params.checkIntervalMs);
    void params.repo.listAccounts().then((accounts) => {
      if (shouldRunAccountScheduler(accounts.length)) {
        void runTokenRefreshSweep();
      }
    });
  };

  applySchedule();

  const configDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("codexAccounts.backgroundTokenRefreshEnabled")) {
      applySchedule();
    }
  });

  params.context.subscriptions.push(configDisposable);
  return {
    dispose(): void {
      configDisposable.dispose();
      if (timer) {
        clearInterval(timer);
      }
    }
  };
}
