import * as vscode from "vscode";
import { AccountsWorkbench } from "./presentation/workbench/accountsWorkbench";
import {
  disposeCodexProxyEnvironment,
  getCodexProxyConfigurationError,
  initializeCodexProxyEnvironment
} from "./infrastructure/config/proxyEnvironment";

let workbench: AccountsWorkbench | undefined;

/**
 * 激活扩展
 *
 * @param context - 扩展上下文
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await initializeCodexProxyEnvironment();
  const proxyError = getCodexProxyConfigurationError();
  if (proxyError) {
    void vscode.window.showErrorMessage(`[Codex Accounts Manager] ${proxyError.message}`);
  }
  workbench = new AccountsWorkbench(context);
  await workbench.activate();
}

/**
 * 停用扩展
 */
export function deactivate(): void {
  workbench?.dispose();
  workbench = undefined;
  disposeCodexProxyEnvironment();
}
