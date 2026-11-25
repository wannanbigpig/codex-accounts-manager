import { getErrorMessage } from "../core/errors";
import type {
  CodexAccountRecord,
  CodexImportPreviewIssue,
  CodexImportPreviewSummary,
  CodexImportResultIssue,
  SharedCodexAccountJson
} from "../core/types";
import { normalizeQuotaSummary } from "../utils/quotaWindows";
import { normalizePlanType } from "../utils/quotaLabels";
import { clearDerivedWorkspaceData } from "./accountMetadata";
import {
  fromSharedQuota,
  fromSharedQuotaError,
  normalizeAccountTags,
  normalizeEpochMs,
  previewSharedEntry,
  sanitizeOptionalValue
} from "./sharedAccounts";

export function toSharedEntries(input: unknown): unknown[] {
  return Array.isArray(input) ? input : [input];
}

function isSharedAccountEntry(entry: unknown): entry is SharedCodexAccountJson {
  return typeof entry === "object" && entry !== null && !Array.isArray(entry);
}

export function requireSharedAccountEntry(entry: unknown): SharedCodexAccountJson {
  if (!isSharedAccountEntry(entry)) {
    throw new Error("Shared account entry must be a JSON object");
  }
  return entry;
}

export function previewSharedAccountsImportEntries(
  entries: unknown[],
  existingIds: Set<string>,
  accounts: readonly CodexAccountRecord[] = []
): CodexImportPreviewSummary {
  const invalidEntries: CodexImportPreviewIssue[] = [];
  const validEntries: NonNullable<CodexImportPreviewSummary["validEntries"]> = [];
  let valid = 0;
  let overwriteCount = 0;

  entries.forEach((entry, index) => {
    try {
      const preview = previewSharedEntry(requireSharedAccountEntry(entry), accounts);
      valid += 1;
      validEntries.push({ index, email: preview.email });
      if (preview.storageId && existingIds.has(preview.storageId)) {
        overwriteCount += 1;
      }
    } catch (error) {
      invalidEntries.push(createSharedImportIssue(entry, index, error));
    }
  });

  return {
    total: entries.length,
    valid,
    overwriteCount,
    invalidCount: invalidEntries.length,
    invalidEntries,
    ...(validEntries.length ? { validEntries } : {})
  };
}

export function createSharedImportIssue(entry: unknown, index: number, error: unknown): CodexImportResultIssue {
  const account = isSharedAccountEntry(entry) ? entry : undefined;
  return {
    index,
    accountId: sanitizeOptionalValue(account?.account_id) ?? sanitizeOptionalValue(account?.id),
    email: sanitizeOptionalValue(account?.email),
    message: typeof error === "string" ? error : getErrorMessage(error)
  };
}

export function applySharedAccountEntry(account: CodexAccountRecord, entry: SharedCodexAccountJson): void {
  const accountId = sanitizeOptionalValue(entry.account_id) ?? account.accountId;
  const organizationId = sanitizeOptionalValue(entry.organization_id) ?? account.organizationId;
  const userId = sanitizeOptionalValue(entry.user_id) ?? account.userId;
  if (
    (account.accountId && account.accountId !== accountId) ||
    (account.organizationId && account.organizationId !== organizationId) ||
    (account.userId && account.userId !== userId)
  ) {
    clearDerivedWorkspaceData(account);
  }
  if (!account.subscriptionExpirySource) {
    account.planType = normalizePlanType(sanitizeOptionalValue(entry.plan_type) ?? account.planType);
    account.subscriptionActiveUntil = sanitizeOptionalValue(entry.subscription_active_until) ?? account.subscriptionActiveUntil;
  }
  account.userId = userId;
  account.accountId = accountId;
  account.organizationId = organizationId;
  account.accountName = sanitizeOptionalValue(entry.account_name) ?? account.accountName;
  account.tags = normalizeAccountTags(entry.tags, account.tags);
  account.addedVia = sanitizeOptionalValue(entry.added_via) ?? account.addedVia ?? "json";
  account.accountStructure = sanitizeOptionalValue(entry.account_structure) ?? account.accountStructure;
  account.createdAt = normalizeEpochMs(entry.created_at) ?? account.createdAt;
  account.updatedAt = normalizeEpochMs(entry.last_used) ?? normalizeEpochMs(entry.added_at ?? undefined) ?? Date.now();

  if (entry.quota !== undefined) {
    account.quotaSummary = entry.quota ? normalizeQuotaSummary(fromSharedQuota(entry.quota)) : undefined;
    if (account.quotaSummary) {
      account.lastQuotaAt = account.updatedAt;
    }
  }

  if (entry.quota_error !== undefined) {
    account.quotaError = fromSharedQuotaError(entry.quota_error);
    if (account.quotaError) {
      account.lastQuotaAt = account.updatedAt;
    }
  }
}
