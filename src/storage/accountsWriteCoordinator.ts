import { backupCurrentIndex, countAvailableBackups, writeIndexAtomically } from "./accountsPersistence";
import type { CodexAccountsIndex } from "../core/types";
import { createError } from "../core/errors";
import type { AccountsRepositoryState } from "./accountsRepositoryState";

export function assertWriteAllowed(state: AccountsRepositoryState): void {
  if (state.indexHealth.status === "corrupted_unrecoverable") {
    console.warn("[codexAccounts] blocked write because accounts index is corrupted");
    throw createError.storageWriteBlocked("Accounts index is corrupted. Restore accounts before writing again.");
  }
}

export async function persistIndexWithBackups(params: {
  state: AccountsRepositoryState;
  indexPath: string;
  index: CodexAccountsIndex;
  tempSuffix: string;
  backupCount: number;
}): Promise<void> {
  assertWriteAllowed(params.state);
  try {
    await backupCurrentIndex(params.indexPath, params.backupCount);
    await writeIndexAtomically(params.indexPath, params.index, params.tempSuffix);
    const availableBackups = await countAvailableBackups(params.indexPath, params.backupCount);
    params.state.indexHealth = { ...params.state.indexHealth, availableBackups };
  } catch (cause) {
    throw createError.storageWriteFailed(params.indexPath, cause);
  }
}
