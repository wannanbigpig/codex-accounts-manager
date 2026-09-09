import { needsRefresh, refreshTokens } from "../../auth/oauth";
import { APIError } from "../../core/errors";
import type { CodexTokens } from "../../core/types";
import type { AccountsRepository } from "../../storage";

/** Execute one account-scoped request with token preflight and a single 401 retry. */
export async function runAuthenticatedAccountRequest<T>(
  repo: Pick<AccountsRepository, "getTokens" | "updateTokens">,
  accountId: string,
  request: (tokens: CodexTokens) => Promise<T>,
  initialTokens?: CodexTokens
): Promise<T> {
  const storedTokens = initialTokens ?? (await repo.getTokens(accountId));
  if (!storedTokens?.accessToken) {
    throw new Error("No access token available");
  }

  let effectiveTokens = storedTokens;
  if (!initialTokens && storedTokens.refreshToken && needsRefresh(storedTokens.accessToken)) {
    effectiveTokens = await refreshAndPersistTokens(repo, accountId, storedTokens);
  }

  try {
    return await request(effectiveTokens);
  } catch (error) {
    if (!isUnauthorized(error) || !effectiveTokens.refreshToken) {
      throw error;
    }

    const refreshedTokens = await refreshAndPersistTokens(repo, accountId, effectiveTokens);
    return request(refreshedTokens);
  }
}

async function refreshAndPersistTokens(
  repo: Pick<AccountsRepository, "updateTokens">,
  accountId: string,
  tokens: CodexTokens
): Promise<CodexTokens> {
  if (!tokens.refreshToken) {
    return tokens;
  }

  const refreshed = await refreshTokens(tokens.refreshToken, tokens.idToken);
  const effectiveTokens: CodexTokens = {
    ...tokens,
    ...refreshed,
    accountId: refreshed.accountId ?? tokens.accountId
  };
  await repo.updateTokens(accountId, effectiveTokens);
  return effectiveTokens;
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof APIError && error.statusCode === 401;
}
