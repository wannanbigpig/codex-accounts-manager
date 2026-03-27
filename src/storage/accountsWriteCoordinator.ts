import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { cloneIndex } from "./accountsIndex";
import {
  backupCurrentIndex,
  backupCurrentIndexSync,
  countAvailableBackups,
  countAvailableBackupsSyncSafe,
  writeIndexAtomically,
  writeIndexAtomicallySync
} from "./accountsPersistence";
import type { CodexAccountsIndex } from "../core/types";
import { createError } from "../core/errors";
import type { AccountsRepositoryState } from "./accountsRepositoryState";

export function disposeWriteCoordinator(
  state: AccountsRepositoryState,
  persistSync: (index: CodexAccountsIndex) => void
): void {
  if (state.saveDebounceTimer) {
    clearTimeout(state.saveDebounceTimer);
    state.saveDebounceTimer = null;
  }

  if (!state.isDirty) {
    return;
  }

  const latestIndex = state.pendingSave ?? state.cache?.data;
  if (latestIndex) {
    persistSync(latestIndex);
  }
  state.pendingSave = null;
  state.isDirty = false;
}

export function readPendingOrCachedIndex(
  state: AccountsRepositoryState,
  cacheTtlMs: number
): CodexAccountsIndex | undefined {
  if (state.pendingSave) {
    return cloneIndex(state.pendingSave);
  }

  if (!state.cache) {
    return undefined;
  }

  const age = Date.now() - state.cache.timestamp;
  if (age >= cacheTtlMs) {
    return undefined;
  }

  return cloneIndex(state.cache.data);
}

export function setCachedIndex(state: AccountsRepositoryState, index: CodexAccountsIndex): void {
  state.cache = {
    data: cloneIndex(index),
    timestamp: Date.now()
  };
}

export function markPendingSave(
  state: AccountsRepositoryState,
  index: CodexAccountsIndex,
  debounceDelayMs: number,
  flush: () => void
): void {
  const snapshot = cloneIndex(index);
  state.cache = {
    data: snapshot,
    timestamp: Date.now()
  };
  state.isDirty = true;

  if (state.saveDebounceTimer) {
    clearTimeout(state.saveDebounceTimer);
  }

  state.pendingSave = snapshot;
  state.saveDebounceTimer = setTimeout(flush, debounceDelayMs);
}

export function markRecoveryPending(state: AccountsRepositoryState, index: CodexAccountsIndex): void {
  if (state.saveDebounceTimer) {
    clearTimeout(state.saveDebounceTimer);
    state.saveDebounceTimer = null;
  }

  const snapshot = cloneIndex(index);
  state.cache = {
    data: snapshot,
    timestamp: Date.now()
  };
  state.pendingSave = snapshot;
  state.isDirty = true;
}

export async function flushPendingSave(
  state: AccountsRepositoryState,
  persistIndex: (index: CodexAccountsIndex) => Promise<void>
): Promise<void> {
  const snapshot = state.pendingSave;
  state.saveDebounceTimer = null;

  if (!snapshot) {
    return;
  }

  const persistTask = state.persistChain
    .catch(() => undefined)
    .then(async () => {
      await persistIndex(snapshot);
    });
  state.persistChain = persistTask;

  try {
    await persistTask;
    if (state.pendingSave === snapshot) {
      state.pendingSave = null;
    }
    if (!state.pendingSave) {
      state.isDirty = false;
    }
  } catch (error) {
    console.error("[codexAccounts] failed to persist accounts index:", error);
  }
}

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
  try {
    await fs.mkdir(path.dirname(params.indexPath), { recursive: true });
    await backupCurrentIndex(params.indexPath, params.backupCount);
    await writeIndexAtomically(params.indexPath, params.index, params.tempSuffix);
    const availableBackups = await countAvailableBackups(params.indexPath, params.backupCount);
    params.state.indexHealth =
      params.state.indexHealth.status === "corrupted_unrecoverable"
        ? { status: "healthy", availableBackups }
        : { ...params.state.indexHealth, availableBackups };
  } catch (cause) {
    throw createError.storageWriteFailed(params.indexPath, cause);
  }
}

export function persistIndexSyncWithBackups(params: {
  state: AccountsRepositoryState;
  indexPath: string;
  index: CodexAccountsIndex;
  tempSuffix: string;
  backupCount: number;
}): void {
  try {
    fsSync.mkdirSync(path.dirname(params.indexPath), { recursive: true });
    backupCurrentIndexSync(params.indexPath, params.backupCount);
    writeIndexAtomicallySync(params.indexPath, params.index, params.tempSuffix);
    const availableBackups = countAvailableBackupsSyncSafe(params.indexPath, params.backupCount);
    params.state.indexHealth =
      params.state.indexHealth.status === "corrupted_unrecoverable"
        ? { status: "healthy", availableBackups }
        : { ...params.state.indexHealth, availableBackups };
  } catch (cause) {
    throw createError.storageWriteFailed(params.indexPath, cause);
  }
}
