import type { CodexAccountRecord, CodexIndexHealthSummary } from "../../core/types";

export function buildWorkbenchRefreshSignature(params: {
  observedAuthIdentity?: string;
  indexHealth: CodexIndexHealthSummary;
  accounts: CodexAccountRecord[];
}): string {
  const accountSignature = params.accounts
    .map((account) =>
      [
        account.id,
        account.email,
        account.accountName ?? "",
        account.planType ?? "",
        account.accountId ?? "",
        account.organizationId ?? "",
        account.userId ?? "",
        (account.tags ?? []).join(","),
        account.isActive ? "1" : "0",
        account.showInStatusBar ? "1" : "0",
        account.lastQuotaAt ?? 0,
        account.updatedAt,
        account.quotaError?.code ?? "",
        account.quotaError?.message ?? "",
        account.quotaError?.timestamp ?? 0,
        account.quotaSummary?.hourlyPercentage ?? "",
        account.quotaSummary?.hourlyResetTime ?? "",
        account.quotaSummary?.hourlyWindowMinutes ?? "",
        account.quotaSummary?.hourlyWindowPresent ? "1" : "0",
        account.quotaSummary?.weeklyPercentage ?? "",
        account.quotaSummary?.weeklyResetTime ?? "",
        account.quotaSummary?.weeklyWindowMinutes ?? "",
        account.quotaSummary?.weeklyWindowPresent ? "1" : "0",
        account.quotaSummary?.codeReviewPercentage ?? "",
        account.quotaSummary?.codeReviewResetTime ?? "",
        account.quotaSummary?.codeReviewWindowMinutes ?? "",
        account.quotaSummary?.codeReviewWindowPresent ? "1" : "0"
      ].join(":")
    )
    .join("|");

  return [
    params.observedAuthIdentity ?? "",
    params.indexHealth.status,
    params.indexHealth.lastRestoreSource ?? "",
    params.indexHealth.availableBackups,
    params.indexHealth.lastErrorMessage ?? "",
    params.indexHealth.lastRecoveredAt ?? "",
    accountSignature
  ].join("||");
}

export function shouldRunAccountScheduler(accountCount: number): boolean {
  return accountCount > 0;
}
