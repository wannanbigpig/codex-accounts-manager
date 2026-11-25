import type { CodexResetCredit } from "../core/types";

export function isAvailableResetCredit(credit: CodexResetCredit, now = Date.now()): boolean {
  const status = credit.status?.trim().toLowerCase() ?? "available";
  return !["redeemed", "used", "consumed", "expired"].includes(status) &&
    credit.redeemed_at === undefined && (credit.expires_at === undefined || credit.expires_at * 1000 > now);
}
