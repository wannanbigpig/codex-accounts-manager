import type { CodexImportQuotaProbe } from "../../core/types";
import { refreshQuota } from "../../services/quota";
import { restoreSharedTokens } from "../../storage/sharedAccounts";
import { requireSharedAccountEntry, toSharedEntries } from "../../storage/sharedAccountsImport";
import { buildAccountStorageId, conflictsWithAccessTokenIdentity } from "../../utils/accountIdentity";
import { runWithConcurrencyLimit } from "../../utils/concurrency";
import { extractClaims } from "../../utils/jwt";

export async function probeSharedImportQuotas(input: unknown, selected: number[], validIndexes: number[]): Promise<CodexImportQuotaProbe[]> {
  const entries = toSharedEntries(input);
  const requested = new Set(selected);
  const indexes = validIndexes.filter((index) => requested.has(index));
  const results: CodexImportQuotaProbe[] = [];
  await runWithConcurrencyLimit(indexes, 2, async (index, position) => {
    try {
      const tokens = restoreSharedTokens(requireSharedAccountEntry(entries[index]));
      const claims = extractClaims(tokens.idToken, tokens.accessToken);
      if (
        !claims.email || !claims.accountId || (tokens.accountId && tokens.accountId !== claims.accountId) ||
        conflictsWithAccessTokenIdentity(claims, tokens.accessToken)
      ) {
        results[position] = { index, status: "failed" };
        return;
      }
      // A synthetic key isolates unsaved credentials from normal refreshes.
      const { quota, error } = await refreshQuota({
        id: `import-preview:${buildAccountStorageId(claims.email, claims.accountId, claims.organizationId)}`,
        email: claims.email, userId: claims.userId, accountId: claims.accountId,
        organizationId: claims.organizationId, planType: claims.planType,
        isActive: false, createdAt: 0, updatedAt: 0
      }, tokens, true);
      results[position] = quota ? {
        index, status: "available",
        hourlyPercentage: quota.hourlyWindowPresent ? quota.hourlyPercentage : undefined,
        weeklyPercentage: quota.weeklyWindowPresent ? quota.weeklyPercentage : undefined
      } : { index, status: error?.statusCode === 401 ? "unauthorized" : error?.statusCode === 429 ? "rate_limited" : "failed" };
    } catch {
      results[position] = { index, status: "failed" };
    }
  });
  return results;
}
