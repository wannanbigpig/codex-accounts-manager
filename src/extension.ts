import * as vscode from "vscode";
import { registerCommands } from "./commands";
import { AccountsRepository } from "./storage/accounts";
import { AccountsStatusBarProvider } from "./ui/statusBar";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const repo = new AccountsRepository(context);
  await repo.init();

  const statusBar = new AccountsStatusBarProvider(context, repo);

  const refreshers = {
    refresh(): void {
      void statusBar.refresh();
    }
  };

  registerCommands(context, repo, refreshers);
  await statusBar.refresh();
}

export function deactivate(): void {}
