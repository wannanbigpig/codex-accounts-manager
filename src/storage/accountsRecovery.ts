import * as fs from "fs/promises";
import * as path from "path";
import { createEmptyIndex, cloneIndex, getBackupPath } from "./accountsIndex";
import {
  backupCurrentIndex,
  countAvailableBackups,
  isFileNotFoundError,
  readIndexSnapshot,
  writeIndexAtomically
} from "./accountsPersistence";
import type { CodexAccountsIndex, CodexAccountsRestoreResult } from "../core/types";
import { createError, ErrorCode, StorageError, getErrorMessage } from "../core/errors";
import type { AccountsRepositoryState } from "./accountsRepositoryState";

export function isIndexHealthError(error: unknown): boolean {
  return (
    error instanceof StorageError &&
    (error.code === ErrorCode.STORAGE_INDEX_CORRUPTED ||
      error.code === ErrorCode.STORAGE_INDEX_RECOVERY_FAILED ||
      error.code === ErrorCode.STORAGE_WRITE_BLOCKED)
  );
}

export async function restoreMissingIndex(
  state: AccountsRepositoryState,
  indexPath: string,
  backupCount: number
): Promise<CodexAccountsIndex> {
  console.info("[codexAccounts] accounts index not found, using empty index");
  state.indexHealth = {
    status: "healthy",
    availableBackups: await countAvailableBackups(indexPath, backupCount)
  };
  const empty = createEmptyIndex();
  state.cache = {
    data: empty,
    timestamp: Date.now()
  };
  return cloneIndex(empty);
}

export async function markUnrecoverableIndex(params: {
  state: AccountsRepositoryState;
  indexPath: string;
  backupCount: number;
  cause: unknown;
}): Promise<never> {
  params.state.cache = null;
  params.state.pendingSave = null;
  params.state.indexHealth = {
    status: "corrupted_unrecoverable",
    lastRestoreSource: params.state.indexHealth.lastRestoreSource,
    availableBackups: await countAvailableBackups(params.indexPath, params.backupCount),
    lastErrorMessage: getErrorMessage(params.cause)
  };
  throw createError.storageIndexRecoveryFailed(params.indexPath, params.cause);
}

export async function readIndexForRecovery(
  state: AccountsRepositoryState,
  readIndex: () => Promise<CodexAccountsIndex>
): Promise<CodexAccountsIndex> {
  try {
    return await readIndex();
  } catch (error) {
    if (!isIndexHealthError(error)) {
      throw error;
    }

    const empty = createEmptyIndex();
    state.cache = {
      data: empty,
      timestamp: Date.now()
    };
    return cloneIndex(empty);
  }
}

export async function persistRecoveredIndex(params: {
  state: AccountsRepositoryState;
  index: CodexAccountsIndex;
  source: CodexAccountsRestoreResult["source"];
  indexPath: string;
  tempSuffix: string;
  backupCount: number;
}): Promise<void> {
  if (params.state.saveDebounceTimer) {
    clearTimeout(params.state.saveDebounceTimer);
    params.state.saveDebounceTimer = null;
  }
  params.state.pendingSave = null;
  await fs.mkdir(path.dirname(params.indexPath), { recursive: true });
  await backupCurrentIndex(params.indexPath, params.backupCount);
  await writeIndexAtomically(params.indexPath, params.index, params.tempSuffix);
  params.state.isDirty = false;
  params.state.cache = {
    data: cloneIndex(params.index),
    timestamp: Date.now()
  };
  params.state.indexHealth = {
    status: params.source === "backup" ? "restored_from_backup" : "healthy",
    lastRestoreSource: params.source,
    availableBackups: await countAvailableBackups(params.indexPath, params.backupCount),
    lastRecoveredAt: Date.now()
  };
}

export async function tryRestoreFromBackups(params: {
  state: AccountsRepositoryState;
  indexPath: string;
  backupCount: number;
  tempSuffix: string;
  source: CodexAccountsRestoreResult["source"];
  originalError?: unknown;
}): Promise<CodexAccountsIndex | undefined> {
  for (let slot = 1; slot <= params.backupCount; slot += 1) {
    const backupPath = getBackupPath(params.indexPath, slot);
    try {
      const snapshot = await readIndexSnapshot(backupPath);
      console.warn(`[codexAccounts] restored accounts index from backup-${slot}`);
      await persistRecoveredIndex({
        state: params.state,
        index: snapshot,
        source: params.source,
        indexPath: params.indexPath,
        tempSuffix: params.tempSuffix,
        backupCount: params.backupCount
      });
      params.state.indexHealth = {
        ...params.state.indexHealth,
        status: "restored_from_backup",
        lastRestoreSource: "backup",
        lastErrorMessage: params.originalError ? getErrorMessage(params.originalError) : undefined
      };
      return snapshot;
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        console.error(`[codexAccounts] failed to restore accounts index from backup-${slot}:`, error);
      }
    }
  }

  return undefined;
}
