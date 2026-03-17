import * as vscode from "vscode";

let networkOutputChannel: vscode.OutputChannel | undefined;

export function registerDebugOutput(context: vscode.ExtensionContext): void {
  if (!networkOutputChannel) {
    networkOutputChannel = vscode.window.createOutputChannel("Codex Accounts Network");
  }

  context.subscriptions.push(networkOutputChannel);
}

export function logNetworkEvent(scope: string, detail: Record<string, unknown>): void {
  if (!vscode.workspace.getConfiguration("codexAccounts").get<boolean>("debugNetwork", false)) {
    return;
  }

  if (!networkOutputChannel) {
    networkOutputChannel = vscode.window.createOutputChannel("Codex Accounts Network");
  }

  const lines = [
    `[${new Date().toISOString()}] ${scope}`,
    ...Object.entries(detail).map(([key, value]) => `${key}: ${formatDebugValue(key, value)}`),
    ""
  ];

  networkOutputChannel.appendLine(lines.join("\n"));
}

function formatDebugValue(key: string, value: unknown): string {
  if (key === "bodyPreview" && typeof value === "string") {
    return sanitizePreview(value);
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function sanitizePreview(value: string): string {
  return value
    .slice(0, 400)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\b(?:org|account|workspace|user)[-_ ]?id\b["':= ]+[\w-]+/gi, "[redacted-id]")
    .replace(/\s+/g, " ")
    .trim();
}
