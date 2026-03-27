import * as fs from "fs/promises";
import * as fsSync from "fs";
import { CodexAccountsIndex } from "../core/types";
import { countAvailableBackupsSync, getBackupPath, parseAccountsIndex, readCurrentIndexForBackupSync } from "./accountsIndex";

export async function readIndexSnapshot(filePath: string): Promise<CodexAccountsIndex> {
  const raw = await fs.readFile(filePath, "utf8");
  return parseAccountsIndex(raw, filePath);
}

export async function countAvailableBackups(indexPath: string, backupCount: number): Promise<number> {
  let count = 0;
  for (let slot = 1; slot <= backupCount; slot += 1) {
    try {
      await fs.access(getBackupPath(indexPath, slot));
      count += 1;
    } catch {
      continue;
    }
  }
  return count;
}

export async function backupCurrentIndex(indexPath: string, backupCount: number): Promise<void> {
  const current = await readCurrentIndexForBackup(indexPath);
  if (!current) {
    return;
  }

  console.info("[codexAccounts] creating accounts index backup");
  for (let slot = backupCount; slot >= 2; slot -= 1) {
    const from = getBackupPath(indexPath, slot - 1);
    const to = getBackupPath(indexPath, slot);
    try {
      await fs.copyFile(from, to);
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        console.error(`[codexAccounts] failed to rotate backup ${slot - 1} -> ${slot}:`, error);
      }
    }
  }

  await fs.writeFile(getBackupPath(indexPath, 1), current, "utf8");
}

export function backupCurrentIndexSync(indexPath: string, backupCount: number): void {
  const current = readCurrentIndexForBackupSync(indexPath);
  if (!current) {
    return;
  }

  for (let slot = backupCount; slot >= 2; slot -= 1) {
    const from = getBackupPath(indexPath, slot - 1);
    const to = getBackupPath(indexPath, slot);
    try {
      fsSync.copyFileSync(from, to);
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        console.error(`[codexAccounts] failed to rotate backup ${slot - 1} -> ${slot}:`, error);
      }
    }
  }

  fsSync.writeFileSync(getBackupPath(indexPath, 1), current, "utf8");
}

export async function writeIndexAtomically(
  indexPath: string,
  index: CodexAccountsIndex,
  tempSuffix: string
): Promise<void> {
  const serialized = JSON.stringify(index, null, 2);
  parseAccountsIndex(serialized, `${indexPath}${tempSuffix}`);
  const tempPath = `${indexPath}${tempSuffix}`;
  await fs.writeFile(tempPath, serialized, "utf8");
  await fs.rename(tempPath, indexPath);
}

export function writeIndexAtomicallySync(indexPath: string, index: CodexAccountsIndex, tempSuffix: string): void {
  const serialized = JSON.stringify(index, null, 2);
  parseAccountsIndex(serialized, `${indexPath}${tempSuffix}`);
  const tempPath = `${indexPath}${tempSuffix}`;
  fsSync.writeFileSync(tempPath, serialized, "utf8");
  fsSync.renameSync(tempPath, indexPath);
}

export function countAvailableBackupsSyncSafe(indexPath: string, backupCount: number): number {
  return countAvailableBackupsSync(indexPath, backupCount);
}

export function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

async function readCurrentIndexForBackup(indexPath: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(indexPath, "utf8");
    parseAccountsIndex(raw, indexPath);
    return raw;
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      console.warn("[codexAccounts] skipped index backup because current index is unreadable");
    }
    return undefined;
  }
}
