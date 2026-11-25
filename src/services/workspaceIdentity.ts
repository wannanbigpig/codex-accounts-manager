type AccountRecord = Record<string, unknown>;
type WorkspaceKind = "personal" | "workspace";

interface WorkspaceHints {
  accountId?: string;
  organizationId?: string;
  name?: string;
  structure?: string;
}

export interface AccountCheckWorkspace {
  record: AccountRecord;
  account: AccountRecord;
  entitlement?: AccountRecord;
  key?: string;
  accountId?: string;
  organizationId?: string;
  name?: string;
  structure?: string;
  kind?: WorkspaceKind;
}

export function selectAccountCheckWorkspace(
  payload: unknown,
  hints: WorkspaceHints
): { workspace: AccountCheckWorkspace; sharedAccountId: boolean } | undefined {
  const accountId = hints.accountId?.trim();
  const organizationId = hints.organizationId?.trim();
  const records = collectWorkspaces(payload, accountId, organizationId);
  const workspace = matchWorkspace(records, payload, { ...hints, accountId, organizationId });
  if (!workspace) {
    return undefined;
  }
  const sharedAccountId = Boolean(
    workspace.accountId && records.some((other) => other !== workspace && other.accountId === workspace.accountId)
  );
  return { workspace, sharedAccountId };
}

export function asAccountCheckRecord(value: unknown): AccountRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AccountRecord) : undefined;
}

export function readAccountCheckString(record: AccountRecord | undefined, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function readWorkspaceString(workspace: AccountCheckWorkspace, keys: string[]): string | undefined {
  return readAccountCheckString(workspace.account, keys) ?? readAccountCheckString(workspace.record, keys);
}

function collectWorkspaces(payload: unknown, accountId?: string, organizationId?: string): AccountCheckWorkspace[] {
  const accounts = asAccountCheckRecord(payload)?.["accounts"] ?? payload;
  const entries: Array<[string | undefined, unknown]> = Array.isArray(accounts)
    ? accounts.map((value) => [undefined, value])
    : Object.entries(asAccountCheckRecord(asAccountCheckRecord(payload)?.["accounts"]) ?? {});

  return entries.flatMap(([mapKey, value]) => {
    const record = asAccountCheckRecord(value);
    if (!record) {
      return [];
    }
    const account = asAccountCheckRecord(record["account"]) ?? record;
    const entitlement = asAccountCheckRecord(record["entitlement"]) ?? asAccountCheckRecord(account["entitlement"]);
    const key = mapKey ?? readAccountCheckString(record, ["key"]);
    const workspace = { record, account, entitlement, key };
    const explicitId = readWorkspaceString(workspace, ["account_id", "id", "chatgpt_account_id"]);
    if (key && key === accountId && explicitId && explicitId !== accountId) {
      return [];
    }
    const workspaceId = readWorkspaceString(workspace, ["workspace_id"]);
    const id = explicitId ?? (key && (key === accountId || looksLikeAccountId(key)) ? key : workspaceId);
    const organizationKey = key === organizationId ? key : undefined;
    const workspaceOrg = workspaceId !== id ? workspaceId : undefined;
    const org = readWorkspaceString(workspace, ["organization_id", "org_id"]) ?? organizationKey ?? workspaceOrg;
    const name = readWorkspaceString(workspace, ["name", "display_name", "account_name", "organization_name", "workspace_name", "title"]);
    const structure = readWorkspaceString(workspace, ["structure", "account_structure", "kind", "type", "account_type"]);
    const plan = readWorkspaceString(workspace, ["plan_type", "planType"])
      ?? readAccountCheckString(entitlement, ["subscription_plan"]);
    return [{ ...workspace, accountId: id, organizationId: org, name, structure, kind: workspaceKind(structure, plan) }];
  });
}

function matchWorkspace(records: AccountCheckWorkspace[], payload: unknown, hints: WorkspaceHints): AccountCheckWorkspace | undefined {
  const { accountId, organizationId } = hints;
  const idMatches = accountId ? records.filter((item) => item.accountId === accountId) : [];
  if (organizationId) {
    const orgMatches = records.filter((item) => item.organizationId === organizationId);
    const exact = accountId ? orgMatches.filter((item) => item.accountId === accountId) : [];
    if (exact.length) {
      return uniqueMatch(exact, hints);
    }
    const compatibleOrgMatches = accountId ? orgMatches.filter((item) => !item.accountId) : orgMatches;
    if (compatibleOrgMatches.length) {
      return uniqueMatch(compatibleOrgMatches, hints);
    }
    if (orgMatches.length) {
      return undefined;
    }
    // A unique exact ID may come from a response which omits organization metadata.
    const exactId = idMatches.length === 1 ? idMatches[0] : undefined;
    const kind = workspaceKind(hints.structure);
    return exactId && !exactId.organizationId && (!kind || !exactId.kind || kind === exactId.kind) ? exactId : undefined;
  }

  if (accountId) {
    if (idMatches.length > 1) {
      return uniqueMatch(idMatches, hints);
    }
    const exact = idMatches[0];
    const kind = workspaceKind(hints.structure);
    if (exact && (!kind || !exact.kind || exact.kind === kind)) {
      return exact;
    }
    // A saved Personal record may carry a historical Team ID. Repair it only
    // when the response identifies a unique workspace of the intended kind.
    return kind === "personal" ? matchByHints(records.filter((item) => item.kind === kind), hints, true) : undefined;
  }

  if (hints.name?.trim() || hints.structure?.trim()) {
    return matchByHints(records, hints, true);
  }
  const ordering = asAccountCheckRecord(payload)?.["account_ordering"];
  const first = Array.isArray(ordering)
    ? (ordering as unknown[]).find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim()
    : undefined;
  return records.find((item) => first && (item.key === first || item.accountId === first))
    ?? records.find((item) => item.account["is_default"] === true || item.record["is_default"] === true)
    ?? records[0];
}

function uniqueMatch(records: AccountCheckWorkspace[], hints: WorkspaceHints): AccountCheckWorkspace | undefined {
  return records.length === 1 ? records[0] : matchByHints(records, hints, true);
}

function matchByHints(
  records: AccountCheckWorkspace[],
  hints: WorkspaceHints,
  allowKindAlone: boolean
): AccountCheckWorkspace | undefined {
  const kind = workspaceKind(hints.structure);
  const name = hints.name?.trim().toLowerCase();
  if (name && !["personal", "team", "workspace", "organization", "business"].includes(name)) {
    const named = records.filter((item) => item.name?.toLowerCase() === name && (!kind || !item.kind || item.kind === kind));
    if (named.length) {
      return named.length === 1 ? named[0] : undefined;
    }
  }
  if (kind && allowKindAlone) {
    const typed = records.filter((item) => item.kind === kind);
    return typed.length === 1 ? typed[0] : undefined;
  }
  return undefined;
}

function looksLikeAccountId(value: string): boolean {
  return /^(?:acct_|account-)|^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}

export function workspaceKind(structure?: string, plan?: string): WorkspaceKind | undefined {
  const normalized = structure?.trim().toLowerCase();
  if (normalized === "personal") {
    return "personal";
  }
  if (normalized && ["workspace", "team", "organization", "business", "enterprise"].includes(normalized)) {
    return "workspace";
  }
  if (plan && /team|business|enterprise/i.test(plan)) {
    return "workspace";
  }
  return plan && /^(free|plus|pro)$/i.test(plan) ? "personal" : undefined;
}
