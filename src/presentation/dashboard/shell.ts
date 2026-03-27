import * as vscode from "vscode";
import type { ExtensionSettingsStore } from "../../infrastructure/config/extensionSettings";

export function renderDashboardShell(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  settingsStore: Pick<ExtensionSettingsStore, "resolveLanguage">
): string {
  const sharedStyles = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "webview", "shared.css"));
  const pageStyles = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "media", "webview", "quotaSummary.css")
  );
  const script = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "media", "webview", "dashboard", "dashboard.js")
  );

  return `<!DOCTYPE html>
<html lang="${settingsStore.resolveLanguage()}">
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
