import * as vscode from "vscode";
import { getDashboardCopy } from "../../application/dashboard/copy";
import type { DashboardSettingKey } from "../../domain/dashboard/types";
import {
  ExtensionSettingsStore,
  getCodexAccountsConfiguration,
  normalizeAutoRefreshMinutes,
  normalizeDashboardTheme
} from "../../infrastructure/config/extensionSettings";
import { isDashboardLanguageOption } from "../../localization/languages";

type DashboardConfigurationKey = DashboardSettingKey | "codexAppPath";

export async function handleDashboardSettingUpdate(
  key: DashboardSettingKey,
  value: string | number | boolean
): Promise<boolean> {
  const config = getCodexAccountsConfiguration();
  let updated = false;

  switch (key) {
    case "dashboardTheme":
      if (typeof value === "string") {
        await updateDashboardConfiguration(config, key, normalizeDashboardTheme(value));
        updated = true;
      }
      break;
    case "codexAppRestartEnabled":
    case "autoSwitchEnabled":
    case "autoSwitchReloadWindowEnabled":
    case "backgroundTokenRefreshEnabled":
    case "quotaWarningEnabled":
    case "debugNetwork":
      if (typeof value === "boolean") {
        await updateDashboardConfiguration(config, key, value);
        updated = true;
      }
      break;
    case "codexAppRestartMode":
      if (value === "auto" || value === "manual") {
        await updateDashboardConfiguration(config, key, value);
        updated = true;
      }
      break;
    case "autoSwitchHourlyThreshold":
    case "autoSwitchWeeklyThreshold":
    case "quotaWarningThreshold":
    case "quotaGreenThreshold":
    case "quotaYellowThreshold":
    case "autoSwitchLockMinutes":
      if (typeof value === "number") {
        await updateDashboardConfiguration(config, key, value);
        updated = true;
      }
      break;
    case "autoRefreshMinutes":
      if (typeof value === "number") {
        await updateDashboardConfiguration(config, key, normalizeAutoRefreshMinutes(value));
        updated = true;
      }
      break;
    case "displayLanguage":
      if (typeof value === "string" && isDashboardLanguageOption(value)) {
        await updateDashboardConfiguration(config, key, value);
        updated = true;
      }
      break;
    default:
      return false;
  }

  return updated;
}

async function updateDashboardConfiguration(
  config: vscode.WorkspaceConfiguration,
  key: DashboardConfigurationKey,
  value: string | number | boolean
): Promise<void> {
  await config.update(key, value, resolveConfigurationTarget(config, key));
}

function resolveConfigurationTarget(
  config: vscode.WorkspaceConfiguration,
  key: DashboardConfigurationKey
): vscode.ConfigurationTarget {
  const inspected = config.inspect(key);
  if (inspected?.workspaceFolderValue !== undefined) {
    return vscode.ConfigurationTarget.WorkspaceFolder;
  }
  if (inspected?.workspaceValue !== undefined) {
    return vscode.ConfigurationTarget.Workspace;
  }
  return vscode.ConfigurationTarget.Global;
}

export async function pickDashboardCodexAppPath(settingsStore: Pick<ExtensionSettingsStore, "resolveLanguage">): Promise<void> {
  const pickerCopy = getDashboardCopy(settingsStore.resolveLanguage());
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: pickerCopy.pickPath
  });

  if (!selected?.[0]) {
    return;
  }

  const config = getCodexAccountsConfiguration();
  const target = resolveConfigurationTarget(config, "codexAppPath");
  await config.update("codexAppPath", selected[0].fsPath, target);
}
