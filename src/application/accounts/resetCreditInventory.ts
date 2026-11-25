import type { CodexAccountRecord, CodexTokens } from "../../core/types";
import { fetchResetCredits } from "../../services";
import type { AccountsRepository } from "../../storage";
import { sameAccountWorkspace } from "../../storage/accountMetadata";
import { runAuthenticatedAccountRequest } from "./authenticatedAccountRequest";
import { resolveResetCreditWorkspace, type ResetCreditWorkspace } from "./resetCreditRedemption";

export function refreshResetCreditInventory(
  repo: AccountsRepository,
  account: CodexAccountRecord,
  options: { force?: boolean; tokens?: CodexTokens } = {}
) {
  return repo.refreshResetCreditInventory(account, (current) => {
    let requestedWorkspace: ResetCreditWorkspace | undefined;
    return runAuthenticatedAccountRequest(repo, current.id, (tokens) => {
      const workspace = resolveResetCreditWorkspace(current, tokens);
      if (requestedWorkspace && !sameAccountWorkspace(requestedWorkspace, workspace)) {
        throw new Error("Codex credentials changed workspace while reading reset credit inventory");
      }
      requestedWorkspace = workspace;
      return fetchResetCredits(tokens.accessToken, workspace.accountId);
    }, options.tokens);
  }, options.force);
}
