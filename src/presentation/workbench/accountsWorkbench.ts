import * as vscode from "vscode";
import { registerCommands } from "../../commands";
import { AccountsRepository } from "../../storage";
import { AccountsStatusBarProvider } from "../../ui";
import { registerDebugOutput, t } from "../../utils";
import { initAutoSwitchRuntimeState } from "./autoSwitchState";
import { WorkbenchRefreshCoordinator } from "./refreshCoordinator";
import { registerAutoRefreshScheduler, registerTokenRefreshScheduler } from "./schedulerRegistration";

const TOKEN_REFRESH_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const TOKEN_REFRESH_SKEW_SECONDS = 10 * 60;

export class AccountsWorkbench {
  private readonly repo: AccountsRepository;
  private readonly statusBar: AccountsStatusBarProvider;
  private readonly refreshCoordinator: WorkbenchRefreshCoordinator;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.repo = new AccountsRepository(context);
    this.statusBar = new AccountsStatusBarProvider(context, this.repo);
    this.refreshCoordinator = new WorkbenchRefreshCoordinator(context, this.repo, this.statusBar);
  }

  async activate(): Promise<void> {
    const activationStartedAt = Date.now();
    const activationSteps: Array<{ name: string; durationMs: number }> = [];
    const measureStep = async <T>(name: string, task: () => T | Promise<T>): Promise<T> => {
      const startedAt = Date.now();
      try {
        return await task();
      } finally {
        activationSteps.push({ name, durationMs: Date.now() - startedAt });
      }
    };

    registerDebugOutput(this.context);
    initAutoSwitchRuntimeState(this.context);
    await measureStep("repo.init", async () => {
      await this.repo.init();
    });
    await measureStep("notifyIndexHealth", async () => {
      await this.notifyIndexHealth();
    });
    await measureStep("refreshCoordinator.initObservedAuthIdentity", async () => {
      await this.refreshCoordinator.initializeObservedAuthIdentity();
    });
    this.context.subscriptions.push({ dispose: () => this.repo.dispose() });
    this.context.subscriptions.push({ dispose: () => this.refreshCoordinator.dispose() });

    const refreshers = this.refreshCoordinator.createRefreshView();
    await measureStep("registerCommands", () => {
      registerCommands(this.context, this.repo, refreshers);
    });
    await measureStep("registerAuthFileWatcher", () => {
      this.context.subscriptions.push(this.refreshCoordinator.registerAuthFileWatcher(refreshers));
    });
    await measureStep("registerAutoRefreshScheduler", () => {
      this.context.subscriptions.push(
        registerAutoRefreshScheduler({
          context: this.context,
          repo: this.repo,
          onRefresh: refreshers.refresh
        })
      );
    });
    await measureStep("registerTokenRefreshScheduler", () => {
      this.context.subscriptions.push(
        registerTokenRefreshScheduler({
          context: this.context,
          repo: this.repo,
          view: refreshers,
          checkIntervalMs: TOKEN_REFRESH_CHECK_INTERVAL_MS,
          skewSeconds: TOKEN_REFRESH_SKEW_SECONDS
        })
      );
    });
    await measureStep("promptImportCurrentAccountIfNeeded", async () => {
      await this.refreshCoordinator.promptImportCurrentAccountIfNeeded(refreshers);
    });
    await measureStep("statusBar.refresh", async () => {
      await this.statusBar.refresh();
    });
    console.info(
      `[codexAccounts] activation completed in ${Date.now() - activationStartedAt}ms`,
      activationSteps.map((step) => `${step.name}=${step.durationMs}ms`).join(", ")
    );
  }

  dispose(): void {
    this.refreshCoordinator.dispose();
    this.repo.dispose();
  }

  private async notifyIndexHealth(): Promise<void> {
    const summary = await this.repo.getIndexHealthSummary();
    const translate = t();
    if (summary.status === "restored_from_backup") {
      void vscode.window.showInformationMessage(translate("message.indexAutoRestored"));
      return;
    }

    if (summary.status === "corrupted_unrecoverable") {
      void vscode.window.showWarningMessage(translate("message.indexRecoveryFailed"));
    }
  }
}
