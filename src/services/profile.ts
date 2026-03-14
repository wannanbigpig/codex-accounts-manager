import { CodexTokens } from "../types";
import { extractClaims } from "../utils/jwt";

const ACCOUNT_CHECK_URL = "https://chatgpt.com/backend-api/wham/accounts/check";

export interface RemoteAccountProfile {
  accountName?: string;
  accountStructure?: string;
  accountId?: string;
}

export async function fetchRemoteAccountProfile(tokens: CodexTokens): Promise<RemoteAccountProfile | undefined> {
  const claims = extractClaims(tokens.idToken, tokens.accessToken);
  const headers = new Headers({
    Authorization: `Bearer ${tokens.accessToken}`,
    Accept: "application/json"
  });

  const accountId = tokens.accountId ?? claims.accountId;
  if (accountId) {
    headers.set("ChatGPT-Account-Id", accountId);
  }

  const response = await fetch(ACCOUNT_CHECK_URL, {
    method: "GET",
    headers
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Account profile API returned ${response.status}: ${raw.slice(0, 200)}`);
  }

  const payload = JSON.parse(raw) as Record<string, unknown>;
  return parseAccountProfile(payload, claims.accountId, claims.organizationId);
}

function parseAccountProfile(
  payload: Record<string, unknown>,
  expectedAccountId?: string,
  expectedOrgId?: string
): RemoteAccountProfile | undefined {
  const records = collectAccountRecords(payload);
  if (!records.length) {
    return undefined;
  }

  const orderedFirstId = Array.isArray(payload.account_ordering)
    ? payload.account_ordering.find((item): item is string => typeof item === "string" && item.trim().length > 0)
    : undefined;

  let selected =
    findById(records, expectedAccountId) ??
    findById(records, orderedFirstId) ??
    findByOrg(records, expectedOrgId) ??
    records[0];

  return {
    accountName: readField(selected, [
      "name",
      "display_name",
      "account_name",
      "organization_name",
      "workspace_name",
      "title"
    ]),
    accountStructure: readField(selected, [
      "structure",
      "account_structure",
      "kind",
      "type",
      "account_type"
    ]),
    accountId: readField(selected, ["id", "account_id", "chatgpt_account_id", "workspace_id"])
  };
}

function collectAccountRecords(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const accountsValue = payload.accounts;
  if (Array.isArray(accountsValue)) {
    return accountsValue.filter(isRecord);
  }

  if (isRecord(accountsValue)) {
    return Object.values(accountsValue).filter(isRecord);
  }

  return [];
}

function findById(records: Array<Record<string, unknown>>, expectedId?: string): Record<string, unknown> | undefined {
  if (!expectedId) {
    return undefined;
  }

  return records.find((record) => {
    const candidate = readField(record, ["id", "account_id", "chatgpt_account_id", "workspace_id"]);
    return candidate === expectedId;
  });
}

function findByOrg(records: Array<Record<string, unknown>>, expectedOrgId?: string): Record<string, unknown> | undefined {
  if (!expectedOrgId) {
    return undefined;
  }

  return records.find((record) => {
    const candidate = readField(record, ["organization_id", "org_id", "workspace_id"]);
    return candidate === expectedOrgId;
  });
}

function readField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
