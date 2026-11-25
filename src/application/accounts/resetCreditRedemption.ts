import type { CodexAccountRecord, CodexResetCreditRedemption, CodexTokens } from "../../core/types";
import { extractClaims } from "../../utils/jwt";

export type ResetCreditWorkspace = Pick<CodexResetCreditRedemption, "accountId" | "organizationId" | "userId">;

export function hasPendingResetCreditRedemption(account: CodexAccountRecord): boolean {
  const attempt = account.resetCreditRedemption;
  return Boolean(attempt?.pending &&
    (!account.accountId || account.accountId === attempt.accountId) &&
    (!account.organizationId || account.organizationId === attempt.organizationId) &&
    (!account.userId || account.userId === attempt.userId));
}

export function resolveResetCreditWorkspace(account: CodexAccountRecord, tokens: CodexTokens): ResetCreditWorkspace {
  let claims: ReturnType<typeof extractClaims> | undefined;
  try {
    claims = extractClaims(tokens.idToken, tokens.accessToken);
  } catch {
    // Some saved records have an explicit account ID but no readable JWT claims.
  }
  if (
    (account.organizationId && claims?.organizationId && claims.organizationId !== account.organizationId) ||
    (account.userId && claims?.userId && claims.userId !== account.userId)
  ) {
    throw new Error("Codex credentials no longer match the workspace for this reset request.");
  }
  const accountId = account.accountId ?? tokens.accountId ?? claims?.accountId;
  if (!accountId) {
    throw new Error("The Codex workspace could not be identified. Sync account information before redeeming a reset credit.");
  }
  return {
    accountId,
    organizationId: account.organizationId ?? claims?.organizationId,
    userId: account.userId ?? claims?.userId
  };
}
