import type { CodexIndexHealthSummary } from "../core/types";

export interface AccountsRepositoryState {
  indexHealth: CodexIndexHealthSummary;
}

export function createAccountsRepositoryState(): AccountsRepositoryState {
  return { indexHealth: { status: "healthy", availableBackups: 0 } };
}
