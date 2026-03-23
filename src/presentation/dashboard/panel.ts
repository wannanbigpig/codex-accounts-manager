import * as vscode from "vscode";
import { buildDashboardState } from "../../application/dashboard/buildDashboardState";
import { getDashboardCopy } from "../../application/dashboard/copy";
import {
  DashboardActionName,
  DashboardActionPayload,
  DashboardClientMessage,
  DashboardHostMessage,
  DashboardSettingKey
} from "../../domain/dashboard/types";
import { completeOAuthLoginSession, prepareOAuthLoginSession, PreparedOAuthLoginSession } from "../../auth/oauth";
import type { SharedCodexAccountJson } from "../../core/types";
import { isDashboardLanguageOption } from "../../localization/languages";
import { ExtensionSettingsStore } from "../../infrastructure/config/extensionSettings";
import { AccountsRepository } from "../../storage";
import { getCommandCopy, t } from "../../utils";

const DASHBOARD_VIEW_TYPE = "codexQuotaSummary";

let dashboardPanelController: DashboardPanelController | undefined;

class DashboardPanelController {
  private readonly settingsStore = new ExtensionSettingsStore();
  private panel: vscode.WebviewPanel | undefined;
  private configWatcher: vscode.Disposable | undefined;
  private webviewReady = false;
  private publishTimer: NodeJS.Timeout | undefined;
  private readonly oauthSessions = new Map<string, PreparedOAuthLoginSession>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repo: AccountsRepository
  ) {}

  open(): void {
    const panelTitle = getDashboardCopy(this.settingsStore.resolveLanguage()).panelTitle;
    const iconUri = vscode.Uri.joinPath(this.context.extensionUri, "media", "CT_logo_transparent_square_hd.png");

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(DASHBOARD_VIEW_TYPE, panelTitle, vscode.ViewColumn.Beside, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")]
      });
      this.panel.iconPath = iconUri;
      this.panel.webview.html = this.renderShell(this.panel.webview);

      this.panel.onDidDispose(() => {
        if (this.publishTimer) {
          clearTimeout(this.publishTimer);
          this.publishTimer = undefined;
        }
        this.configWatcher?.dispose();
        this.configWatcher = undefined;
        this.oauthSessions.clear();
        this.panel = undefined;
        this.webviewReady = false;
      });

      this.panel.webview.onDidReceiveMessage((message: DashboardClientMessage) => {
        void this.handleMessage(message);
      });

      this.configWatcher = this.settingsStore.onDidChange(() => {
        this.schedulePublishState();
      });
    } else {
      this.panel.title = panelTitle;
      this.panel.iconPath = iconUri;
      this.panel.reveal(vscode.ViewColumn.Beside, false);
    }

    if (this.webviewReady) {
      this.schedulePublishState();
    }
  }

  async refresh(): Promise<void> {
    if (!this.panel || !this.webviewReady) {
      return;
    }

    await this.publishState();
  }

  private schedulePublishState(delayMs = 0): void {
    if (!this.panel) {
      return;
    }

    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
    }

    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      void this.publishState();
    }, delayMs);
  }

  private reloadShell(): void {
    if (!this.panel) {
      return;
    }

    this.webviewReady = false;
    this.panel.webview.html = this.renderShell(this.panel.webview);
  }

  private async publishState(): Promise<void> {
    if (!this.panel || !this.webviewReady) {
      return;
    }

    const logoUri = this.panel.webview
      .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "CT_logo_transparent_square_hd.png"))
      .toString();
    const state = await buildDashboardState(this.repo, this.settingsStore, logoUri);
    this.panel.title = state.panelTitle;

    const message: DashboardHostMessage = {
      type: "dashboard:snapshot",
      state
    };
    await this.panel.webview.postMessage(message);
  }

  private async handleMessage(message: DashboardClientMessage): Promise<void> {
    switch (message.type) {
      case "dashboard:ready":
        this.webviewReady = true;
        this.schedulePublishState();
        return;
      case "dashboard:action":
        await this.handleActionMessage(message);
        return;
      case "dashboard:setting":
        await this.handleSettingUpdate(message.key, message.value);
        return;
      case "dashboard:pickCodexAppPath":
        await this.pickCodexAppPath();
        return;
      case "dashboard:clearCodexAppPath":
        await vscode.workspace
          .getConfiguration("codexAccounts")
          .update("codexAppPath", "", vscode.ConfigurationTarget.Global);
        return;
      default:
        return;
    }
  }

  private async handleActionMessage(
    message: Extract<DashboardClientMessage, { type: "dashboard:action" }>
  ): Promise<void> {
    let status: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["status"] = "completed";
    let payload: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["payload"];
    let errorMessage: string | undefined;

    try {
      const account = message.accountId ? await this.repo.getAccount(message.accountId) : undefined;
      payload = await this.runAction(message.action, message.payload, account);
    } catch (error) {
      status = "failed";
      errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[codexAccounts] dashboard action failed: ${message.action}`, error);
    } finally {
      await this.postActionResult(message.requestId, message.action, status, message.accountId, payload, errorMessage);
    }
  }

  private async runAction(
    action: DashboardActionName,
    payload: DashboardActionPayload | undefined,
    account?: Awaited<ReturnType<AccountsRepository["getAccount"]>>
  ): Promise<Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["payload"] | undefined> {
    const translate = t(this.settingsStore.resolveLanguage());

    switch (action) {
      case "addAccount":
        await vscode.commands.executeCommand("codexAccounts.addAccount");
        return undefined;
      case "importCurrent":
        await vscode.commands.executeCommand("codexAccounts.importCurrentAuth");
        return undefined;
      case "refreshAll":
        await vscode.commands.executeCommand("codexAccounts.refreshAllQuotas");
        return undefined;
      case "shareTokens": {
        try {
          const accountIds = payload?.accountIds ?? [];
          const shared = await this.repo.exportSharedAccounts(accountIds);
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
            message: error instanceof Error ? error.message : String(error)
          });
          void vscode.window.showErrorMessage(message);
          throw new Error(message);
        }
      }
      case "copyText": {
        const text = payload?.text ?? "";
        if (!text) {
          return undefined;
        }
        await vscode.env.clipboard.writeText(text);
        return undefined;
      }
      case "openExternalUrl": {
        const url = payload?.url?.trim();
        if (!url) {
          return undefined;
        }
        await vscode.env.openExternal(vscode.Uri.parse(url));
        return undefined;
      }
      case "downloadJsonFile": {
        const text = payload?.text ?? "";
        const defaultName = payload?.filename?.trim() ?? "codex-accounts-manager-share.json";
        if (!text) {
          return undefined;
        }

        const target = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.joinPath(this.context.globalStorageUri, defaultName),
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
      case "importSharedJson": {
        const jsonText = payload?.jsonText?.trim();
        if (!jsonText) {
          const message = translate("message.sharedJsonParseFailed", {
            message: "Empty JSON input"
          });
          void vscode.window.showErrorMessage(message);
          throw new Error(message);
        }

        let parsed: SharedCodexAccountJson | SharedCodexAccountJson[];
        try {
          parsed = JSON.parse(jsonText) as SharedCodexAccountJson | SharedCodexAccountJson[];
        } catch (error) {
          const message = translate("message.sharedJsonParseFailed", {
            message: error instanceof Error ? error.message : String(error)
          });
          void vscode.window.showErrorMessage(message);
          throw new Error(message);
        }

        try {
          const imported = await this.repo.importSharedAccounts(parsed);
          this.schedulePublishState();
          void vscode.window.showInformationMessage(
            translate("message.importSharedJsonSuccess", {
              count: imported.length
            })
          );
          return {
            importedCount: imported.length,
            importedEmails: imported.map((item) => item.email)
          };
        } catch (error) {
          const message = translate("message.importSharedJsonFailed", {
            message: error instanceof Error ? error.message : String(error)
          });
          void vscode.window.showErrorMessage(message);
          throw new Error(message);
        }
      }
      case "prepareOAuthSession": {
        try {
          const prepared = prepareOAuthLoginSession();
          const sessionId = `oauth-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
          this.oauthSessions.set(sessionId, prepared);
          return {
            oauthSession: {
              sessionId,
              authUrl: prepared.authUrl,
              redirectUri: prepared.redirectUri
            }
          };
        } catch (error) {
          const message = translate("message.oauthPrepareFailed", {
            message: error instanceof Error ? error.message : String(error)
          });
          void vscode.window.showErrorMessage(message);
          throw new Error(message);
        }
      }
      case "completeOAuthSession": {
        const oauthSessionId = payload?.oauthSessionId;
        const callbackUrl = payload?.callbackUrl?.trim();
        if (!oauthSessionId || !callbackUrl) {
          const message = translate("message.oauthCallbackFailed", {
            message: "Missing OAuth session or callback URL"
          });
          void vscode.window.showErrorMessage(message);
          throw new Error(message);
        }

        const session = this.oauthSessions.get(oauthSessionId);
        if (!session) {
          const message = translate("message.oauthPrepareFailed", {
            message: "OAuth session expired"
          });
          void vscode.window.showErrorMessage(message);
          throw new Error(message);
        }

        try {
          const tokens = await completeOAuthLoginSession(session, callbackUrl);
          const created = await this.repo.upsertFromTokens(tokens, false);
          this.oauthSessions.delete(oauthSessionId);
          this.schedulePublishState();
          void vscode.window.showInformationMessage(
            translate("message.oauthCompleted", {
              email: created.email
            })
          );
          return {
            email: created.email
          };
        } catch (error) {
          const message = translate("message.oauthCallbackFailed", {
            message: error instanceof Error ? error.message : String(error)
          });
          void vscode.window.showErrorMessage(message);
          throw new Error(message);
        }
      }
      case "refreshView":
        this.reloadShell();
        return undefined;
      case "reloadPrompt":
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
      case "reauthorize":
        if (account) {
          await vscode.commands.executeCommand("codexAccounts.reauthorizeAccount", account);
        }
        return undefined;
      case "details":
        if (account) {
          await vscode.commands.executeCommand("codexAccounts.openDetails", account);
        }
        return undefined;
      case "switch":
        if (account) {
          await vscode.commands.executeCommand("codexAccounts.switchAccount", account);
        }
        return undefined;
      case "refresh":
        if (account) {
          await vscode.commands.executeCommand("codexAccounts.refreshQuota", account);
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
      default:
        return undefined;
    }
  }

  private async postActionResult(
    requestId: string,
    action: DashboardActionName,
    status: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["status"],
    accountId?: string,
    payload?: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["payload"],
    error?: string
  ): Promise<void> {
    if (!this.panel) {
      return;
    }

    const message: DashboardHostMessage = {
      type: "dashboard:action-result",
      requestId,
      action,
      accountId,
      status,
      payload,
      error
    };
    await this.panel.webview.postMessage(message);
  }

  private async handleSettingUpdate(key: DashboardSettingKey, value: string | number | boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration("codexAccounts");
    let updated = false;

    switch (key) {
      case "codexAppRestartEnabled":
        if (typeof value === "boolean") {
          await config.update(key, value, vscode.ConfigurationTarget.Global);
          updated = true;
        }
        break;
      case "codexAppRestartMode":
        if (value === "auto" || value === "manual") {
          await config.update(key, value, vscode.ConfigurationTarget.Global);
          updated = true;
        }
        break;
      case "autoRefreshMinutes":
      case "autoSwitchHourlyThreshold":
      case "autoSwitchWeeklyThreshold":
      case "quotaWarningThreshold":
      case "quotaGreenThreshold":
      case "quotaYellowThreshold":
        if (typeof value === "number") {
          await config.update(key, value, vscode.ConfigurationTarget.Global);
          updated = true;
        }
        break;
      case "autoSwitchEnabled":
      case "showCodeReviewQuota":
      case "quotaWarningEnabled":
      case "debugNetwork":
        if (typeof value === "boolean") {
          await config.update(key, value, vscode.ConfigurationTarget.Global);
          updated = true;
        }
        break;
      case "displayLanguage":
        if (typeof value === "string" && isDashboardLanguageOption(value)) {
          await config.update(key, value, vscode.ConfigurationTarget.Global);
          updated = true;
        }
        break;
      default:
        return;
    }

    if (!updated) {
      return;
    }

    this.schedulePublishState();
  }

  private async pickCodexAppPath(): Promise<void> {
    const pickerCopy = getDashboardCopy(this.settingsStore.resolveLanguage());
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: pickerCopy.pickPath
    });

    if (!selected?.[0]) {
      return;
    }

    await vscode.workspace
      .getConfiguration("codexAccounts")
      .update("codexAppPath", selected[0].fsPath, vscode.ConfigurationTarget.Global);
  }

  private renderShell(webview: vscode.Webview): string {
    const sharedStyles = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "webview", "shared.css")
    );
    const pageStyles = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "webview", "quotaSummary.css")
    );
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "webview", "dashboard", "dashboard.js")
    );

    return `<!DOCTYPE html>
<html lang="${this.settingsStore.resolveLanguage()}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource};"
  />
  <link rel="stylesheet" href="${sharedStyles.toString()}" />
  <link rel="stylesheet" href="${pageStyles.toString()}" />
</head>
<body>
  <div id="app"></div>
  <script src="${script.toString()}"></script>
</body>
</html>`;
  }
}

export function openQuotaSummaryPanel(context: vscode.ExtensionContext, repo: AccountsRepository): void {
  dashboardPanelController ??= new DashboardPanelController(context, repo);
  dashboardPanelController.open();
}

export async function refreshQuotaSummaryPanel(): Promise<void> {
  if (!dashboardPanelController) {
    return;
  }

  await dashboardPanelController.refresh();
}
