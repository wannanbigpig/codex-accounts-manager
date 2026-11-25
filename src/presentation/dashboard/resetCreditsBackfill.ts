import type { DashboardAccountViewModel } from "../../domain/dashboard/types";
import { AccountsRepository } from "../../storage";
import { refreshResetCreditInventory } from "../../application/accounts/resetCreditInventory";
import { runWithConcurrencyLimit } from "../../utils/concurrency";
import { logNetworkEvent } from "../../utils/debug";

export function pickResetCreditsBackfillTargets(
  accounts: readonly DashboardAccountViewModel[],
  now = Date.now()
): DashboardAccountViewModel[] {
  return accounts.filter((account) =>
    (account.resetCreditsAvailable ?? 0) > 0 && (account.resetCreditsNextExpiresAt ?? 0) * 1000 <= now
  );
}

export async function backfillMissingResetCreditExpiries(
  repo: AccountsRepository,
  accounts: readonly DashboardAccountViewModel[],
  onUpdated: () => void,
  now = Date.now()
): Promise<boolean> {
  const targets = pickResetCreditsBackfillTargets(accounts, now);
  if (targets.length === 0) {
    return false;
  }

  let updated = false;
  await runWithConcurrencyLimit(targets, 2, async (account) => {
    try {
      const saved = await repo.getAccount(account.id);
      if (!saved) {
        return;
      }
      const snapshot = await refreshResetCreditInventory(repo, saved);
      if (!snapshot) {
        return;
      }
      logNetworkEvent("resetCredits.backfill", {
        accountId: account.id,
        remoteAccountId: account.accountId,
        step: "fetched",
        availableCount: snapshot.availableCount,
        nextExpiresAt: snapshot.nextExpiresAt ?? null,
        creditsCount: snapshot.credits.length
      });
      if (snapshot.availableCount > 0 && snapshot.nextExpiresAt == null) {
        console.info(
          `[codexAccounts] reset credits backfill returned ${snapshot.availableCount} credit(s) without an expiry for ${
            account.email ?? account.id
          }`
        );
      }
      updated = true;
    } catch (error) {
      console.warn(`[codexAccounts] reset credits backfill failed for ${account.email ?? account.id}:`, error);
      logNetworkEvent("resetCredits.backfill", {
        accountId: account.id,
        remoteAccountId: account.accountId,
        step: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  if (updated) {
    onUpdated();
  }
  return updated;
}
