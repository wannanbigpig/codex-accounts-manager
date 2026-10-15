import { APIError } from "../../core/errors";
import type { CodexTokens } from "../../core/types";
import type { AccountsRepository } from "../../storage";

/** Execute one account-scoped request with token preflight and a single 401 retry. */
export async function runAuthenticatedAccountRequest<T>(
  repo: Pick<AccountsRepository, "getFreshTokens">,
  accountId: string,
  request: (tokens: CodexTokens) => Promise<T>,
  initialTokens?: CodexTokens
): Promise<T> {
  const storedTokens = initialTokens ?? (await repo.getFreshTokens(accountId));
  if (!storedTokens?.accessToken) {
    throw new Error("No access token available");
  }

  const effectiveTokens = storedTokens;

  try {
    return await request(effectiveTokens);
  } catch (error) {
    if (!isUnauthorized(error) || !effectiveTokens.refreshToken) {
      throw error;
    }

    const refreshedTokens = await repo.getFreshTokens(accountId, { force: true, expectedTokens: effectiveTokens });
    if (!refreshedTokens?.accessToken) {
      throw new Error("No access token available");
    }
    return request(refreshedTokens);
  }
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof APIError && error.statusCode === 401;
}
