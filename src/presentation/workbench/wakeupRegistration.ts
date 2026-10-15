import * as os from "os";
import * as path from "path";
import type * as vscode from "vscode";
import type { AccountsRepository } from "../../storage";
import { WakeupStore } from "../../storage/wakeupStore";
import { WakeupService } from "../../application/wakeup/service";
import { runAuthenticatedAccountRequest } from "../../application/accounts/authenticatedAccountRequest";
import { sendWakeupRequest } from "../../services/wakeupClient";
import { refreshQuota } from "../../services/quota";

let service: WakeupService | undefined;

export function getWakeupService(): WakeupService | undefined {
  return service;
}

export async function registerWakeupScheduler(
  context: vscode.ExtensionContext,
  repo: AccountsRepository,
  onChange: () => void
): Promise<void> {
  service = new WakeupService(
    new WakeupStore(path.join(os.homedir(), ".codex-accounts-manager", "wakeup")),
    repo,
    async (id, task, signal) => {
      const selectedAccount = await repo.getAccount(id);
      const diagnostic = await runAuthenticatedAccountRequest(repo, id, (tokens) =>
        sendWakeupRequest({ ...tokens, accountId: tokens.accountId ?? selectedAccount?.accountId }, task, signal)
      );
      let quotaWarning: string | undefined;
      // Refresh quota directly; waking an account must not switch the user's current account.
      try {
        const account = await repo.getAccount(id);
        const tokens = await repo.getFreshTokens(id);
        if (account && tokens && !signal.aborted) {
          const result = await refreshQuota(account, tokens, true);
          quotaWarning = result.error?.message;
          await repo.updateQuota(
            id,
            result.quota,
            result.error,
            result.updatedTokens,
            result.updatedPlanType,
            result.updatedSubscriptionActiveUntil,
            tokens
          );
        }
      } catch {
        quotaWarning = "Post-wakeup quota refresh failed";
        console.warn("[codexAccounts] post-wakeup quota refresh failed");
      }
      return { ...diagnostic, quotaWarning };
    },
    onChange
  );
  const instance = service;
  context.subscriptions.push({
    dispose: () => {
      instance.dispose();
      if (service === instance) {
        service = undefined;
      }
    }
  });
  await instance.start();
}
