import * as vscode from "vscode";
import type { CodexAccountRecord } from "../../core/types";
import { getCodexAccountsConfiguration } from "../../infrastructure/config/extensionSettings";
import { needsWindowReloadForAccount } from "../../presentation/workbench/windowRuntimeAccount";
import { getCodexAppRestartCopy, getCodexAppState, getCommandCopy, restartCodexAppIfInstalled } from "../../utils";

const CODEX_APP_RESTART_MODE = "codexAppRestartMode";
const CODEX_APP_RESTART_ENABLED = "codexAppRestartEnabled";

export async function handleCodexAppRestartPreference(options?: { allowManualPrompt?: boolean }): Promise<void> {
  if (!getCodexAccountsConfiguration().get<boolean>(CODEX_APP_RESTART_ENABLED, false)) {
    return;
  }

  const state = await getCodexAppState();
  if (!state.installed || !state.running) {
    return;
  }

  const config = getCodexAccountsConfiguration();
  const mode = config.get<string>(CODEX_APP_RESTART_MODE);
  if (mode === "auto") {
    await restartCodexAppIfInstalled();
    return;
  }

  if (mode !== "manual" || options?.allowManualPrompt === false) {
    return;
  }

  const copy = getCodexAppRestartCopy();
  const manualChoice = await vscode.window.showInformationMessage(copy.manualMessage, copy.restartNow, copy.later);
  if (manualChoice === copy.restartNow) {
    await restartCodexAppIfInstalled();
  }
}

export async function promptWindowReloadForAccount(account: Pick<CodexAccountRecord, "id" | "email">): Promise<boolean> {
  if (!needsWindowReloadForAccount(account.id)) {
    return false;
  }

  const copy = getCommandCopy();
  const choice = await vscode.window.showInformationMessage(copy.switchedAndAskReload(account.email), copy.reloadNow, copy.later);
  if (choice === copy.reloadNow) {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
    return true;
  }
  return false;
}

export async function autoReloadWindowForAccount(accountId?: string): Promise<boolean> {
  if (!needsWindowReloadForAccount(accountId)) {
    return false;
  }

  await vscode.commands.executeCommand("workbench.action.reloadWindow");
  return true;
}
