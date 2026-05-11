import { getErrorMessage } from "../core/errors";
import type {
  CodexAccountRecord,
  CodexImportPreviewIssue,
  CodexImportPreviewSummary,
  CodexImportResultIssue,
  SharedCodexAccountJson
} from "../core/types";
import { normalizeQuotaSummary } from "../utils/quotaWindows";
import {
  fromSharedQuota,
  fromSharedQuotaError,
  normalizeAccountTags,
  normalizeEpochMs,
  previewSharedEntry,
  sanitizeOptionalValue
} from "./sharedAccounts";

export function toSharedEntries(input: SharedCodexAccountJson | SharedCodexAccountJson[]): SharedCodexAccountJson[] {
  const entries = Array.isArray(input) ? input : [input];
  return entries.map(normalizeSharedAccountImportEntry);
}

export function previewSharedAccountsImportEntries(
  entries: SharedCodexAccountJson[],
  existingIds: Set<string>
): CodexImportPreviewSummary {
  const normalizedEntries = toSharedEntries(entries);
  const invalidEntries: CodexImportPreviewIssue[] = [];
  let valid = 0;
  let overwriteCount = 0;

  normalizedEntries.forEach((entry, index) => {
    try {
      const preview = previewSharedEntry(entry);
      valid += 1;
      if (preview.storageId && existingIds.has(preview.storageId)) {
        overwriteCount += 1;
      }
    } catch (error) {
      invalidEntries.push(createSharedImportIssue(entry, index, error));
    }
  });

  return {
    total: normalizedEntries.length,
    valid,
    overwriteCount,
    invalidCount: invalidEntries.length,
    invalidEntries
  };
}

export function createSharedImportIssue(
  entry: SharedCodexAccountJson,
  index: number,
  error: unknown
): CodexImportResultIssue {
  return {
    index,
    accountId: sanitizeOptionalValue(entry.account_id) ?? sanitizeOptionalValue(entry.id),
    email: sanitizeOptionalValue(entry.email),
    message: typeof error === "string" ? error : getErrorMessage(error)
  };
}

export function applySharedAccountEntry(account: CodexAccountRecord, entry: SharedCodexAccountJson): void {
  account.userId = sanitizeOptionalValue(entry.user_id) ?? account.userId;
  account.planType = sanitizeOptionalValue(entry.plan_type) ?? account.planType;
  account.subscriptionActiveUntil = sanitizeOptionalValue(entry.subscription_active_until) ?? account.subscriptionActiveUntil;
  account.accountId = sanitizeOptionalValue(entry.account_id) ?? account.accountId;
  account.organizationId = sanitizeOptionalValue(entry.organization_id) ?? account.organizationId;
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

function normalizeSharedAccountImportEntry(entry: SharedCodexAccountJson): SharedCodexAccountJson {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry.tokens) {
    return entry;
  }

  const record = entry as Record<string, unknown>;
  const accessToken = firstString(record["accessToken"], record["access_token"], record["token"]);
  if (!accessToken || !looksLikeChatGptSession(record)) {
    return entry;
  }

  const user = asRecord(record["user"]);
  const sessionAccount = asRecord(record["account"]);
  return {
    ...entry,
    email: firstString(record["email"], user?.["email"]) ?? entry.email,
    user_id: firstString(record["user_id"], record["userId"], user?.["id"]) ?? entry.user_id,
    plan_type: firstString(record["plan_type"], record["planType"], sessionAccount?.["planType"]) ?? entry.plan_type,
    account_id: firstString(record["account_id"], record["accountId"], sessionAccount?.["id"]) ?? entry.account_id,
    organization_id:
      firstString(record["organization_id"], record["organizationId"], sessionAccount?.["organizationId"]) ??
      entry.organization_id,
    account_name:
      firstString(record["account_name"], record["accountName"], sessionAccount?.["name"], sessionAccount?.["displayName"]) ??
      entry.account_name,
    account_structure:
      firstString(record["account_structure"], record["accountStructure"], sessionAccount?.["structure"]) ??
      entry.account_structure,
    added_via: entry.added_via ?? "session",
    tokens: {
      id_token: firstString(record["id_token"], record["idToken"], accessToken),
      access_token: accessToken,
      refresh_token: firstString(record["refresh_token"], record["refreshToken"]),
      account_id: firstString(record["account_id"], record["accountId"], sessionAccount?.["id"])
    }
  };
}

function looksLikeChatGptSession(record: Record<string, unknown>): boolean {
  const user = asRecord(record["user"]);
  const sessionAccount = asRecord(record["account"]);
  return Boolean(
    record["accessToken"] ||
      record["sessionToken"] ||
      record["authProvider"] ||
      record["expires"] ||
      user?.["email"] ||
      sessionAccount?.["id"] ||
      sessionAccount?.["planType"]
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = sanitizeOptionalValue(value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}
