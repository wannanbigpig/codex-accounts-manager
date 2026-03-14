import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { SecretStore } from "./secrets";
import { readAuthFile, writeAuthFile } from "../codex/authFile";
import {
  CodexAccountRecord,
  CodexAccountsIndex,
  CodexQuotaSummary,
  CodexTokens
} from "../types";
import { fetchRemoteAccountProfile } from "../services/profile";
import { extractClaims } from "../utils/jwt";

const INDEX_FILE = "accounts-index.json";

export class AccountsRepository {
  private readonly secretStore: SecretStore;
  private readonly indexPath: string;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.secretStore = new SecretStore(context.secrets);
    this.indexPath = path.join(context.globalStorageUri.fsPath, INDEX_FILE);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.context.globalStorageUri.fsPath, { recursive: true });
    await this.syncActiveAccountFromAuthFile();
  }

  async listAccounts(): Promise<CodexAccountRecord[]> {
    return (await this.readIndex()).accounts;
  }

  async getAccount(accountId: string): Promise<CodexAccountRecord | undefined> {
    return (await this.readIndex()).accounts.find((item) => item.id === accountId);
  }

  async getTokens(accountId: string): Promise<CodexTokens | undefined> {
    return this.secretStore.getTokens(accountId);
  }

  async upsertFromTokens(tokens: CodexTokens, forceActive = false): Promise<CodexAccountRecord> {
    const claims = extractClaims(tokens.idToken, tokens.accessToken);
    if (!claims.email) {
      throw new Error("Unable to extract email from id_token");
    }

    let remoteProfile;
    try {
      remoteProfile = await fetchRemoteAccountProfile(tokens);
    } catch {
      remoteProfile = undefined;
    }

    const index = await this.readIndex();
    const id = buildAccountStorageId(claims.email, claims.accountId, claims.organizationId);
    const existing = index.accounts.find((item) => item.id === id);
    const now = Date.now();
    const account: CodexAccountRecord = {
      id,
      email: claims.email,
      userId: claims.userId,
      authProvider: claims.authProvider,
      planType: claims.planType,
      accountId: remoteProfile?.accountId ?? claims.accountId ?? tokens.accountId,
      organizationId: claims.organizationId,
      accountName:
        remoteProfile?.accountName ??
        pickWorkspaceLikeTitle(claims.organizations?.map((item) => item.title)) ??
        existing?.accountName,
      accountStructure:
        remoteProfile?.accountStructure ??
        inferAccountStructure(claims.planType, claims.organizationId) ??
        existing?.accountStructure,
      isActive: forceActive,
      showInStatusBar:
        existing?.showInStatusBar ??
        shouldEnableStatusBarByDefault(index.accounts, id),
      lastQuotaAt: existing?.lastQuotaAt,
      quotaSummary: existing?.quotaSummary,
      quotaError: existing?.quotaError,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    index.accounts = index.accounts.filter((item) => item.id !== id);
    index.accounts.push(account);
    if (forceActive) {
      markActive(index, id);
    }

    await this.secretStore.setTokens(id, {
      ...tokens,
      accountId: account.accountId ?? tokens.accountId
    });
    await this.writeIndex(index);
    return account;
  }

  async importCurrentAuth(): Promise<CodexAccountRecord> {
    const auth = await readAuthFile();
    if (!auth) {
      throw new Error("Current auth.json was not found");
    }

    return this.upsertFromTokens(
      {
        idToken: auth.tokens.id_token,
        accessToken: auth.tokens.access_token,
        refreshToken: auth.tokens.refresh_token,
        accountId: auth.tokens.account_id
      },
      true
    );
  }

  async switchAccount(accountId: string): Promise<CodexAccountRecord> {
    const index = await this.readIndex();
    const account = index.accounts.find((item) => item.id === accountId);
    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }
    const previousActiveId = index.currentAccountId;

    const tokens = await this.secretStore.getTokens(accountId);
    if (!tokens) {
      throw new Error(`Tokens missing for account ${account.email}`);
    }

    await writeAuthFile({
      ...tokens,
      accountId: account.accountId ?? tokens.accountId
    });

    markActive(index, accountId);
    reconcileStatusBarSelections(index, accountId, previousActiveId);
    await this.writeIndex(index);
    return index.accounts.find((item) => item.id === accountId)!;
  }

  async removeAccount(accountId: string): Promise<void> {
    const index = await this.readIndex();
    index.accounts = index.accounts.filter((item) => item.id !== accountId);
    if (index.currentAccountId === accountId) {
      index.currentAccountId = undefined;
    }
    await this.secretStore.deleteTokens(accountId);
    await this.writeIndex(index);
  }

  async setStatusBarVisibility(accountId: string, visible: boolean): Promise<CodexAccountRecord> {
    const index = await this.readIndex();
    const account = index.accounts.find((item) => item.id === accountId);
    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }

    if (account.isActive) {
      account.showInStatusBar = false;
    } else if (visible) {
      const enabledCount = index.accounts.filter((item) => !item.isActive && item.showInStatusBar).length;
      if (enabledCount >= 2) {
        throw new Error("Only 2 extra accounts can be shown in the status popup");
      }
      account.showInStatusBar = true;
    } else {
      account.showInStatusBar = false;
    }

    account.updatedAt = Date.now();
    await this.writeIndex(index);
    return account;
  }

  async updateQuota(
    accountId: string,
    quotaSummary?: CodexQuotaSummary,
    quotaError?: CodexAccountRecord["quotaError"],
    updatedTokens?: CodexTokens,
    updatedPlanType?: string
  ): Promise<CodexAccountRecord> {
    const index = await this.readIndex();
    const account = index.accounts.find((item) => item.id === accountId);
    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }

    account.lastQuotaAt = Date.now();
    account.updatedAt = Date.now();
    account.quotaSummary = quotaSummary;
    account.quotaError = quotaError;
    if (updatedPlanType) {
      account.planType = updatedPlanType;
    }

    if (updatedTokens) {
      await this.secretStore.setTokens(accountId, {
        ...updatedTokens,
        accountId: account.accountId ?? updatedTokens.accountId
      });
    }

    await this.writeIndex(index);
    return account;
  }

  async syncActiveAccountFromAuthFile(): Promise<void> {
    const auth = await readAuthFile();
    const index = await this.readIndex();

    if (!auth) {
      return;
    }

    const claims = extractClaims(auth.tokens.id_token, auth.tokens.access_token);
    const derivedId = claims.email
      ? buildAccountStorageId(claims.email, claims.accountId, claims.organizationId)
      : undefined;

    for (const account of index.accounts) {
      account.isActive = account.id === derivedId;
    }

    index.currentAccountId = derivedId;
    await this.writeIndex(index);
  }

  async openCodexHome(): Promise<void> {
    await vscode.commands.executeCommand(
      "revealFileInOS",
      vscode.Uri.file(path.dirname(path.join(process.env.CODEX_HOME ?? "", "auth.json")))
    );
  }

  private async readIndex(): Promise<CodexAccountsIndex> {
    try {
      const raw = await fs.readFile(this.indexPath, "utf8");
      const parsed = JSON.parse(raw) as CodexAccountsIndex;
      parsed.accounts ??= [];
      return parsed;
    } catch {
      return { accounts: [] };
    }
  }

  private async writeIndex(index: CodexAccountsIndex): Promise<void> {
    await fs.mkdir(path.dirname(this.indexPath), { recursive: true });
    await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2), "utf8");
  }
}

function pickWorkspaceLikeTitle(candidates?: Array<string | undefined>): string | undefined {
  if (!candidates?.length) {
    return undefined;
  }

  const normalized = candidates
    .filter((item): item is string => Boolean(item && item.trim()))
    .map((item) => item.trim());

  return normalized.find((item) => item.toLowerCase() !== "personal") ?? normalized[0];
}

function inferAccountStructure(planType?: string, organizationId?: string): string | undefined {
  if (organizationId) {
    return "organization";
  }
  if (planType && planType.toLowerCase() === "team") {
    return "team";
  }
  return "personal";
}

function buildAccountStorageId(
  email: string,
  accountId?: string,
  organizationId?: string
): string {
  const seed = [email.trim(), accountId?.trim(), organizationId?.trim()].filter(Boolean).join("|");
  return `codex_${crypto.createHash("md5").update(seed).digest("hex")}`;
}

function markActive(index: CodexAccountsIndex, accountId: string): void {
  index.currentAccountId = accountId;
  for (const account of index.accounts) {
    account.isActive = account.id === accountId;
  }
}

function reconcileStatusBarSelections(
  index: CodexAccountsIndex,
  nextActiveId: string,
  previousActiveId?: string
): void {
  const nextActive = index.accounts.find((account) => account.id === nextActiveId);
  if (nextActive) {
    nextActive.showInStatusBar = false;
  }

  const extras = index.accounts.filter((account) => account.id !== nextActiveId && account.showInStatusBar);
  if (extras.length > 2) {
    extras
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(2)
      .forEach((account) => {
        account.showInStatusBar = false;
      });
  }

  if (!previousActiveId || previousActiveId === nextActiveId) {
    return;
  }

  const previousActive = index.accounts.find((account) => account.id === previousActiveId);
  if (!previousActive) {
    return;
  }

  const currentExtraCount = index.accounts.filter(
    (account) => account.id !== nextActiveId && account.showInStatusBar
  ).length;
  previousActive.showInStatusBar = currentExtraCount < 2;
  previousActive.updatedAt = Date.now();
}

function shouldEnableStatusBarByDefault(accounts: CodexAccountRecord[], accountId: string): boolean {
  const enabledCount = accounts.filter((item) => item.id !== accountId && !item.isActive && item.showInStatusBar).length;
  return enabledCount < 2;
}
