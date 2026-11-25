import { isDeepStrictEqual } from "util";
import { createError } from "../core/errors";
import type { CodexAccountRecord, CodexAccountsIndex } from "../core/types";
import { normalizeQuotaSummary } from "../utils/quotaWindows";
import { workspaceKind } from "../services/workspaceIdentity";
import { normalizePlanType } from "../utils/quotaLabels";
import { normalizeAccountTags } from "./sharedAccounts";

export function markActive(index: CodexAccountsIndex, accountId: string): void {
  index.currentAccountId = accountId;
  for (const account of index.accounts) {
    account.isActive = account.id === accountId;
  }
}

export function syncActiveAccountState(index: CodexAccountsIndex, accountId: string | undefined): boolean {
  const normalizedAccountId = accountId && index.accounts.some((account) => account.id === accountId) ? accountId : undefined;
  let changed = index.currentAccountId !== normalizedAccountId;
  index.currentAccountId = normalizedAccountId;

  for (const account of index.accounts) {
    const nextActive = account.id === normalizedAccountId;
    if (account.isActive !== nextActive) {
      account.isActive = nextActive;
      changed = true;
    }
  }

  return changed;
}

export function createEmptyIndex(): CodexAccountsIndex {
  return { accounts: [] };
}

export function cloneIndex(index: CodexAccountsIndex): CodexAccountsIndex {
  const accountIds = new Set(Array.isArray(index?.accounts) ? index.accounts.map((account) => account.id) : []);
  const normalized: CodexAccountsIndex = {
    currentAccountId: index?.currentAccountId,
    dashboardAccountOrder: Array.isArray(index?.dashboardAccountOrder)
      ? [...new Set(index.dashboardAccountOrder.filter((id) => accountIds.has(id)))] : undefined,
    accounts: Array.isArray(index?.accounts)
      ? index.accounts.map((account) => ({
          ...account,
          planType: normalizePlanType(account.planType),
          tags: normalizeAccountTags(account.tags),
          quotaSummary: normalizeQuotaSummary(account.quotaSummary, workspaceKind(account.accountStructure, account.planType))
        }))
      : []
  };

  return structuredClone(normalized);
}

/** Apply a caller's edits to the latest disk snapshot, preserving unrelated concurrent changes. */
export function applyIndexChanges(
  latest: CodexAccountsIndex,
  before: CodexAccountsIndex,
  after: CodexAccountsIndex
): void {
  const originals = new Map(before.accounts.map((account) => [account.id, account]));
  const edits = new Map(after.accounts.map((account) => [account.id, account]));
  latest.accounts = latest.accounts.filter((account) => !originals.has(account.id) || edits.has(account.id));
  const records = new Map(latest.accounts.map((account) => [account.id, account]));
  for (const account of after.accounts) {
    const original = originals.get(account.id);
    const current = records.get(account.id);
    if (!current) {
      if (!original) {
        latest.accounts.push({ ...account });
      }
      continue;
    }
    const keys = Object.keys({ ...original, ...account }) as (keyof CodexAccountRecord)[];
    for (const key of keys) {
      if (key !== "isActive" && !isDeepStrictEqual(original?.[key], account[key])) {
        Object.assign(current, { [key]: account[key] });
      }
    }
  }
  const activeId =
    before.currentAccountId === after.currentAccountId
      ? (latest.currentAccountId ?? latest.accounts.find((account) => account.isActive)?.id)
      : after.currentAccountId;
  syncActiveAccountState(latest, activeId);
}

export function parseAccountsIndex(raw: string, filePath: string): CodexAccountsIndex {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidAccountsIndex(parsed)) {
      throw new Error("Invalid accounts index structure");
    }

    return cloneIndex(parsed);
  } catch (cause) {
    throw createError.storageIndexCorrupted(filePath, cause);
  }
}

export function getBackupPath(indexPath: string, slot: number): string {
  return indexPath.replace(/\.json$/i, `.backup-${slot}.json`);
}

function isValidAccountsIndex(value: unknown): value is CodexAccountsIndex {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<CodexAccountsIndex>;
  if (!Array.isArray(candidate.accounts)) {
    return false;
  }

  return candidate.accounts.every((account) => {
    if (!account || typeof account !== "object") {
      return false;
    }

    const record = account as Partial<CodexAccountRecord>;
    return (
      typeof record.id === "string" &&
      typeof record.email === "string" &&
      typeof record.createdAt === "number" &&
      typeof record.updatedAt === "number" &&
      (record.tags === undefined || (Array.isArray(record.tags) && record.tags.every((tag) => typeof tag === "string")))
    );
  });
}
