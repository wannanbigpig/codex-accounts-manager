import * as os from "os";
import * as path from "path";
import type * as vscode from "vscode";
import type { AccountsRepository } from "../../storage";
import { WakeupStore } from "../../storage/wakeupStore";
import { WakeupService } from "../../application/wakeup/service";
import { runAuthenticatedAccountRequest } from "../../application/accounts/authenticatedAccountRequest";
import { refreshStoredAccountQuota } from "../../application/accounts/quota";
import { sendWakeupRequest } from "../../services/wakeupClient";
import { sameAccountWorkspace } from "../../storage/accountMetadata";
import type { CodexAccountRecord } from "../../core/types";
import { collectQuotaResetTimes } from "../../domain/wakeup/schedule";

const SHORT_WINDOW_RECHECK_MS = 30_000;

let service: WakeupService | undefined;

export function getWakeupService(): WakeupService | undefined {
  return service;
}

export async function registerWakeupScheduler(
  context: vscode.ExtensionContext,
  repo: AccountsRepository,
  onChange: () => void
): Promise<void> {
  const rechecks = new Map<string, { timer: NodeJS.Timeout; controller: AbortController }>();
  const shortResetPending = (account: CodexAccountRecord): boolean =>
    !collectQuotaResetTimes(account.quotaSummary && { ...account.quotaSummary, additionalRateLimits: undefined }, "hourly")
      .some((time) => time > Date.now());
  const queueQuotaRecheck = (checked: CodexAccountRecord): void => {
    if (rechecks.has(checked.id)) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        const latest = await repo.getAccount(checked.id);
        if (!latest || !sameAccountWorkspace(latest, checked) || !shortResetPending(latest) || controller.signal.aborted) {
          return;
        }
        const tokens = await repo.getFreshTokens(latest.id);
        if (tokens && !controller.signal.aborted) {
          await refreshStoredAccountQuota(repo, latest, tokens, true, controller.signal);
          if (!controller.signal.aborted) {
            onChange();
          }
        }
      })().catch(() => console.warn("[codexAccounts] post-wakeup quota recheck failed"))
        .finally(() => rechecks.delete(checked.id));
    }, SHORT_WINDOW_RECHECK_MS);
    timer.unref();
    rechecks.set(checked.id, { timer, controller });
  };
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
        if (selectedAccount && account && sameAccountWorkspace(selectedAccount, account) && tokens && !signal.aborted) {
          const { result, updatedAccount } = await refreshStoredAccountQuota(repo, account, tokens, true, signal);
          quotaWarning = result.error?.message;
          if (task.scheduleMode === "quota_reset" && task.quotaResetWindow !== "weekly" && result.quota && !signal.aborted && shortResetPending(updatedAccount)) {
            queueQuotaRecheck(updatedAccount);
          }
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
      for (const { timer, controller } of rechecks.values()) {
        clearTimeout(timer);
        controller.abort();
      }
      rechecks.clear();
      instance.dispose();
      if (service === instance) {
        service = undefined;
      }
    }
  });
  await instance.start();
}
