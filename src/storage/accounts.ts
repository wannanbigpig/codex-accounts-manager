/**
 * 账号存储仓库
 *
 * 优化内容:
 * - 添加内存缓存层，减少重复文件 I/O 操作
 * - 实现缓存失效和持久化机制
 * - 使用防抖保存优化写入性能
 * - 使用统一的错误类型
 * - 添加类型安全的缓存接口
 */

import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { SecretStore } from "./secrets";
import { readAuthFile, writeAuthFile } from "../codex";
import {
  CodexAccountRecord,
  CodexAccountsIndex,
  CodexAccountsRestoreResult,
  CodexImportPreviewIssue,
  CodexImportPreviewSummary,
  CodexImportResultIssue,
  CodexImportResultSummary,
  CodexIndexHealthSummary,
  CodexQuotaSummary,
  CodexTokens,
  SharedCodexAccountJson
} from "../core/types";
import { fetchRemoteAccountProfile } from "../services/profile";
import { buildAccountStorageId } from "../utils/accountIdentity";
import { extractClaims } from "../utils/jwt";
import { normalizeQuotaSummary } from "../utils/quotaWindows";
import { AccountError, StorageError, createError, ErrorCode, getErrorMessage } from "../core/errors";

/** 缓存失效时间 (毫秒) */
const CACHE_TTL_MS = 5000;
/** 防抖延迟 (毫秒) */
const DEBOUNCE_DELAY_MS = 100;

const INDEX_FILE = "accounts-index.json";
const INDEX_TEMP_SUFFIX = ".tmp";
const INDEX_BACKUP_COUNT = 3;

/**
 * 缓存条目类型
 */
interface CacheEntry<T> {
  /** 缓存数据 */
  data: T;
  /** 缓存时间戳 */
  timestamp: number;
}

/**
 * 账号存储仓库
 *
 * 提供账号数据的持久化和缓存管理
 */
export class AccountsRepository {
  private readonly secretStore: SecretStore;
  private readonly indexPath: string;

  /** 内存缓存 - 存储索引数据 */
  private cache: CacheEntry<CodexAccountsIndex> | null = null;

  /** 防抖定时器 */
  private saveDebounceTimer: NodeJS.Timeout | null = null;

  /** 待保存的数据队列 */
  private pendingSave: CodexAccountsIndex | null = null;

  /** 持久化串行队列 */
  private persistChain: Promise<void> = Promise.resolve();

  /** 是否存在尚未安全落盘的改动 */
  private isDirty = false;

  /** 防止重复释放 */
  private disposed = false;

  /** 索引健康状态 */
  private indexHealth: CodexIndexHealthSummary = {
    status: "healthy",
    availableBackups: 0
  };

  constructor(private readonly context: vscode.ExtensionContext) {
    this.secretStore = new SecretStore(context.secrets);
    this.indexPath = path.join(context.globalStorageUri.fsPath, INDEX_FILE);
  }

  /**
   * 初始化仓库
   * - 创建存储目录
   * - 同步激活账号状态
   */
  async init(): Promise<void> {
    try {
      await fs.mkdir(this.context.globalStorageUri.fsPath, { recursive: true });
    } catch (cause) {
      throw createError.storageWriteFailed(this.context.globalStorageUri.fsPath, cause);
    }

    try {
      await this.syncActiveAccountFromAuthFile();
    } catch (cause) {
      if (isIndexHealthError(cause)) {
        console.error("[codexAccounts] accounts index init failed:", cause);
        return;
      }
      throw cause;
    }
  }

  /**
   * 清理资源
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }

    if (this.isDirty) {
      const latestIndex = this.pendingSave ?? this.cache?.data;
      if (latestIndex) {
        this.persistIndexSync(latestIndex);
      }
      this.pendingSave = null;
      this.isDirty = false;
    }
  }

  /**
   * 获取所有账号列表
   */
  async listAccounts(): Promise<CodexAccountRecord[]> {
    try {
      return (await this.readIndex()).accounts;
    } catch (error) {
      if (isIndexHealthError(error)) {
        return [];
      }
      throw error;
    }
  }

  /**
   * 获取单个账号
   */
  async getAccount(accountId: string): Promise<CodexAccountRecord | undefined> {
    try {
      return (await this.readIndex()).accounts.find((item) => item.id === accountId);
    } catch (error) {
      if (isIndexHealthError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async getIndexHealthSummary(): Promise<CodexIndexHealthSummary> {
    try {
      await this.readIndex();
    } catch (error) {
      if (!isIndexHealthError(error)) {
        throw error;
      }
    }

    return {
      ...this.indexHealth,
      availableBackups: await this.countAvailableBackups()
    };
  }

  async restoreIndexFromLatestBackup(): Promise<CodexAccountsRestoreResult> {
    const restored = await this.tryRestoreFromBackups("backup");
    if (!restored) {
      throw createError.storageIndexRecoveryFailed(this.indexPath, this.indexHealth.lastErrorMessage);
    }

    return {
      source: "backup",
      restoredCount: restored.accounts.length,
      restoredEmails: restored.accounts.map((account) => account.email)
    };
  }

  async restoreAccountsFromAuthFile(): Promise<CodexAccountsRestoreResult> {
    const auth = await readAuthFile();
    if (!auth) {
      throw new AccountError("Current auth.json was not found", {
        code: ErrorCode.NOT_FOUND,
        i18nKey: "message.accountNotFound"
      });
    }

    const restored = await this.upsertFromTokensInternal(
      {
        idToken: auth.tokens.id_token,
        accessToken: auth.tokens.access_token,
        refreshToken: auth.tokens.refresh_token,
        accountId: auth.tokens.account_id
      },
      true,
      {
        allowRecoveryWrite: true,
        persistImmediately: true,
        restoreSource: "auth_json"
      }
    );

    return {
      source: "auth_json",
      restoredCount: 1,
      restoredEmails: [restored.email]
    };
  }

  async restoreAccountsFromSharedJson(
    input: SharedCodexAccountJson | SharedCodexAccountJson[]
  ): Promise<CodexAccountsRestoreResult> {
    let restored: CodexAccountRecord[];
    try {
      restored = await this.importSharedAccountsInternal(input, {
        allowRecoveryWrite: true,
        persistImmediately: true,
        restoreSource: "shared_json"
      });
    } catch (error) {
      this.pendingSave = null;
      this.isDirty = false;
      this.cache = this.indexHealth.status === "corrupted_unrecoverable" ? null : this.cache;
      throw error;
    }

    return {
      source: "shared_json",
      restoredCount: restored.length,
      restoredEmails: restored.map((account) => account.email)
    };
  }

  /**
   * 获取账号的令牌
   */
  async getTokens(accountId: string): Promise<CodexTokens | undefined> {
    try {
      return await this.secretStore.getTokens(accountId);
    } catch (cause) {
      throw new StorageError(`Failed to get tokens for ${accountId}`, {
        code: ErrorCode.STORAGE_SECRET_ACCESS_FAILED,
        cause
      });
    }
  }

  async updateTokens(accountId: string, tokens: CodexTokens): Promise<CodexAccountRecord> {
    const index = await this.readIndex();
    const account = index.accounts.find((item) => item.id === accountId);

    if (!account) {
      throw createError.accountNotFound(accountId);
    }

    const effectiveTokens = {
      ...tokens,
      accountId: tokens.accountId ?? account.accountId
    };

    await this.secretStore.setTokens(accountId, effectiveTokens);

    if (effectiveTokens.accountId && effectiveTokens.accountId !== account.accountId) {
      account.accountId = effectiveTokens.accountId;
      account.updatedAt = Date.now();
      this.writeIndex(index);
    }

    if (account.isActive) {
      await writeAuthFile({
        ...effectiveTokens,
        accountId: account.accountId ?? effectiveTokens.accountId
      });
    }

    return account;
  }

  async refreshAccountProfileMetadata(accountId: string): Promise<CodexAccountRecord> {
    const index = await this.readIndex();
    const account = index.accounts.find((item) => item.id === accountId);
    if (!account) {
      throw createError.accountNotFound(accountId);
    }

    const tokens = await this.secretStore.getTokens(accountId);
    if (!tokens) {
      throw new AccountError(`Tokens missing for account ${account.email}`, {
        code: ErrorCode.AUTH_TOKEN_MISSING
      });
    }

    const claims = extractClaims(tokens.idToken, tokens.accessToken);
    const remoteProfile = await fetchRemoteAccountProfile(tokens);
    if (!remoteProfile) {
      throw new AccountError(`No remote profile returned for ${account.email}`, {
        code: ErrorCode.ACCOUNT_INVALID_DATA
      });
    }

    if (didRemoteAccountMatchClaims(remoteProfile, claims.accountId)) {
      const sanitizedName = sanitizeWorkspaceName(remoteProfile.accountName, account.planType);
      if (sanitizedName) {
        account.accountName = sanitizedName;
      }
      account.accountId = remoteProfile.accountId ?? claims.accountId ?? account.accountId;
      account.organizationId = claims.organizationId ?? account.organizationId;
      account.accountStructure = resolveAccountStructure(
        remoteProfile.accountStructure,
        account.accountStructure,
        account.planType,
        account.organizationId
      );
      account.updatedAt = Date.now();
      account.dismissedHealthIssueKey = undefined;
      this.writeIndex(index);
    }

    return account;
  }

  async dismissHealthIssue(accountId: string, issueKey?: string): Promise<CodexAccountRecord> {
    const index = await this.readIndex();
    const account = index.accounts.find((item) => item.id === accountId);
    if (!account) {
      throw createError.accountNotFound(accountId);
    }

    account.dismissedHealthIssueKey = issueKey?.trim() || undefined;
    account.updatedAt = Date.now();
    this.writeIndex(index);
    return account;
  }

  async setAccountTags(accountId: string, tags: string[]): Promise<CodexAccountRecord> {
    const index = await this.readIndex();
    const account = index.accounts.find((item) => item.id === accountId);
    if (!account) {
      throw createError.accountNotFound(accountId);
    }

    account.tags = normalizeAccountTags(tags);
    account.updatedAt = Date.now();
    this.writeIndex(index);
    return { ...account, tags: [...(account.tags ?? [])] };
  }

  async addAccountTags(accountIds: string[], tags: string[]): Promise<CodexAccountRecord[]> {
    const normalizedTags = normalizeAccountTags(tags) ?? [];
    if (!normalizedTags.length) {
      return [];
    }

    const idSet = new Set(accountIds);
    const index = await this.readIndex();
    const updated: CodexAccountRecord[] = [];

    for (const account of index.accounts) {
      if (!idSet.has(account.id)) {
        continue;
      }
      account.tags = normalizeAccountTags([...(account.tags ?? []), ...normalizedTags]);
      account.updatedAt = Date.now();
      updated.push({ ...account, tags: [...(account.tags ?? [])] });
    }

    if (updated.length > 0) {
      this.writeIndex(index);
    }

    return updated;
  }

  async removeAccountTags(accountIds: string[], tags: string[]): Promise<CodexAccountRecord[]> {
    const normalizedTags = normalizeAccountTags(tags) ?? [];
    if (!normalizedTags.length) {
      return [];
    }

    const removeSet = new Set(normalizedTags.map((tag) => tag.toLowerCase()));
    const idSet = new Set(accountIds);
    const index = await this.readIndex();
    const updated: CodexAccountRecord[] = [];

    for (const account of index.accounts) {
      if (!idSet.has(account.id)) {
        continue;
      }

      const nextTags = (account.tags ?? []).filter((tag) => !removeSet.has(tag.toLowerCase()));
      account.tags = normalizeAccountTags(nextTags);
      account.updatedAt = Date.now();
      updated.push({ ...account, tags: [...(account.tags ?? [])] });
    }

    if (updated.length > 0) {
      this.writeIndex(index);
    }

    return updated;
  }

  async previewSharedAccountsImport(
    input: SharedCodexAccountJson | SharedCodexAccountJson[]
  ): Promise<CodexImportPreviewSummary> {
    const entries = Array.isArray(input) ? input : [input];
    const existing = await this.readIndex().catch(() => createEmptyIndex());
    const existingIds = new Set(existing.accounts.map((account) => account.id));
    const invalidEntries: CodexImportPreviewIssue[] = [];
    let valid = 0;
    let overwriteCount = 0;

    entries.forEach((entry, index) => {
      try {
        const preview = previewSharedEntry(entry);
        valid += 1;
        if (preview.storageId && existingIds.has(preview.storageId)) {
          overwriteCount += 1;
        }
      } catch (error) {
        invalidEntries.push({
          index,
          accountId: sanitizeOptionalValue(entry.account_id) ?? sanitizeOptionalValue(entry.id),
          email: sanitizeOptionalValue(entry.email),
          message: getErrorMessage(error)
        });
      }
    });

    return {
      total: entries.length,
      valid,
      overwriteCount,
      invalidCount: invalidEntries.length,
      invalidEntries
    };
  }

  /**
   * 插入或更新账号 (从令牌)
   *
   * @param tokens - 认证令牌
   * @param forceActive - 是否强制设为激活状态
   * @returns 账号记录
   */
  async upsertFromTokens(tokens: CodexTokens, forceActive = false): Promise<CodexAccountRecord> {
    return this.upsertFromTokensInternal(tokens, forceActive);
  }

  private async upsertFromTokensInternal(
    tokens: CodexTokens,
    forceActive = false,
    options: {
      allowRecoveryWrite?: boolean;
      persistImmediately?: boolean;
      restoreSource?: CodexAccountsRestoreResult["source"];
    } = {}
  ): Promise<CodexAccountRecord> {
    const claims = extractClaims(tokens.idToken, tokens.accessToken);
    if (!claims.email) {
      throw new AccountError("Unable to extract email from id_token", {
        code: ErrorCode.ACCOUNT_INVALID_DATA
      });
    }

    // 异步获取远程配置，不阻塞主要流程
    let remoteProfile;
    try {
      remoteProfile = await fetchRemoteAccountProfile(tokens);
    } catch {
      remoteProfile = undefined;
    }

    const index = options.allowRecoveryWrite ? await this.readIndexForRecovery() : await this.readIndex();
    const id = buildAccountStorageId(claims.email, claims.accountId, claims.organizationId);
    const existing = index.accounts.find((item) => item.id === id);
    const now = Date.now();
    const remoteAccountIdMatchesClaims = didRemoteAccountMatchClaims(remoteProfile, claims.accountId);
    const remoteAccountName = remoteAccountIdMatchesClaims ? sanitizeWorkspaceName(remoteProfile?.accountName, claims.planType) : undefined;
    const remoteAccountStructure = remoteAccountIdMatchesClaims ? remoteProfile?.accountStructure : undefined;
    const claimsWorkspaceTitle = pickWorkspaceLikeTitle(claims.organizations?.map((item) => item.title), claims.planType);
    const resolvedAccountName =
      remoteAccountName ??
      sanitizeWorkspaceName(existing?.accountName, claims.planType) ??
      claimsWorkspaceTitle;

    const account: CodexAccountRecord = {
      id,
      loginAt: claims.loginAt ?? existing?.loginAt,
      email: claims.email,
      userId: claims.userId,
      authProvider: claims.authProvider,
      planType: claims.planType,
      accountId: remoteAccountIdMatchesClaims ? remoteProfile?.accountId ?? claims.accountId ?? tokens.accountId : claims.accountId ?? tokens.accountId,
      organizationId: claims.organizationId,
      accountName: resolvedAccountName,
      tags: normalizeAccountTags(existing?.tags),
      accountStructure: resolveAccountStructure(
        remoteAccountStructure,
        existing?.accountStructure,
        claims.planType,
        claims.organizationId
      ),
      isActive: forceActive,
      showInStatusBar: existing?.showInStatusBar ?? shouldEnableStatusBarByDefault(index.accounts, id),
      dismissedHealthIssueKey: existing?.dismissedHealthIssueKey,
      lastQuotaAt: existing?.lastQuotaAt,
      quotaSummary: existing?.quotaSummary,
      quotaError: existing?.quotaError,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    // 替换或添加账号
    index.accounts = index.accounts.filter((item) => item.id !== id);
    index.accounts.push(account);

    if (forceActive) {
      markActive(index, id);
    }

    // 保存令牌
    await this.secretStore.setTokens(id, {
      ...tokens,
      accountId: account.accountId ?? tokens.accountId
    });

    if (options.persistImmediately) {
      await this.persistRecoveredIndex(index, options.restoreSource ?? "shared_json");
    } else if (options.allowRecoveryWrite) {
      if (this.saveDebounceTimer) {
        clearTimeout(this.saveDebounceTimer);
        this.saveDebounceTimer = null;
      }
      const snapshot = cloneIndex(index);
      this.cache = {
        data: snapshot,
        timestamp: Date.now()
      };
      this.pendingSave = snapshot;
      this.isDirty = true;
    } else {
      this.writeIndex(index);
    }

    return account;
  }

  /**
   * 导入当前 auth.json
   */
  async importCurrentAuth(): Promise<CodexAccountRecord> {
    const auth = await readAuthFile();
    if (!auth) {
      throw new AccountError("Current auth.json was not found", {
        code: ErrorCode.NOT_FOUND,
        i18nKey: "message.accountNotFound"
      });
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

  async exportSharedAccounts(accountIds: string[]): Promise<SharedCodexAccountJson[]> {
    const uniqueIds = Array.from(new Set(accountIds));
    if (uniqueIds.length === 0) {
      return [];
    }

    const index = await this.readIndex();
    const accounts = index.accounts.filter((account) => uniqueIds.includes(account.id));
    const sharedAccounts: SharedCodexAccountJson[] = [];

    for (const account of accounts) {
      const tokens = await this.secretStore.getTokens(account.id);
      if (!tokens?.idToken || !tokens.accessToken) {
        continue;
      }

      sharedAccounts.push(toSharedAccountJson(account, tokens));
    }

    return sharedAccounts;
  }

  async importSharedAccounts(input: SharedCodexAccountJson | SharedCodexAccountJson[]): Promise<CodexAccountRecord[]> {
    return this.importSharedAccountsInternal(input);
  }

  async importSharedAccountsWithSummary(
    input: SharedCodexAccountJson | SharedCodexAccountJson[]
  ): Promise<CodexImportResultSummary> {
    const entries = Array.isArray(input) ? input : [input];
    const preview = await this.previewSharedAccountsImport(entries);
    const failures: CodexImportResultIssue[] = [];
    const importedEmails: string[] = [];
    let successCount = 0;

    for (const [index, entry] of entries.entries()) {
      try {
        const imported = await this.importSharedAccountsInternal(entry);
        const first = imported[0];
        if (!first) {
          failures.push({
            index,
            accountId: sanitizeOptionalValue(entry.account_id) ?? sanitizeOptionalValue(entry.id),
            email: sanitizeOptionalValue(entry.email),
            message: "Import returned no account"
          });
          continue;
        }
        successCount += 1;
        importedEmails.push(first.email);
      } catch (error) {
        failures.push({
          index,
          accountId: sanitizeOptionalValue(entry.account_id) ?? sanitizeOptionalValue(entry.id),
          email: sanitizeOptionalValue(entry.email),
          message: getErrorMessage(error)
        });
      }
    }

    return {
      total: entries.length,
      successCount,
      overwriteCount: preview.overwriteCount,
      failedCount: failures.length,
      importedEmails,
      failures
    };
  }

  private async importSharedAccountsInternal(
    input: SharedCodexAccountJson | SharedCodexAccountJson[],
    options: {
      allowRecoveryWrite?: boolean;
      persistImmediately?: boolean;
      restoreSource?: CodexAccountsRestoreResult["source"];
    } = {}
  ): Promise<CodexAccountRecord[]> {
    const entries = Array.isArray(input) ? input : [input];
    const imported: CodexAccountRecord[] = [];

    for (const entry of entries) {
      const restoredTokens = restoreSharedTokens(entry);
      const created = await this.upsertFromTokensInternal(restoredTokens, false, {
        allowRecoveryWrite: options.allowRecoveryWrite,
        persistImmediately: false
      });
      const index = options.allowRecoveryWrite ? await this.readIndexForRecovery() : await this.readIndex();
      const account = index.accounts.find((item) => item.id === created.id);
      if (!account) {
        continue;
      }

      account.userId = sanitizeOptionalValue(entry.user_id) ?? account.userId;
      account.planType = sanitizeOptionalValue(entry.plan_type) ?? account.planType;
      account.accountId = sanitizeOptionalValue(entry.account_id) ?? account.accountId;
      account.organizationId = sanitizeOptionalValue(entry.organization_id) ?? account.organizationId;
      account.accountName = sanitizeOptionalValue(entry.account_name) ?? account.accountName;
      account.tags = normalizeAccountTags(entry.tags, account.tags);
      account.accountStructure = sanitizeOptionalValue(entry.account_structure) ?? account.accountStructure;
      account.createdAt = normalizeEpochMs(entry.created_at) ?? account.createdAt;
      account.updatedAt = normalizeEpochMs(entry.last_used) ?? Date.now();

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

      await this.secretStore.setTokens(account.id, {
        ...restoredTokens,
        accountId: account.accountId ?? restoredTokens.accountId
      });

      if (options.persistImmediately) {
        await this.persistRecoveredIndex(index, options.restoreSource ?? "shared_json");
      } else {
        this.writeIndex(index);
      }
      imported.push({ ...account });
    }

    return imported;
  }

  /**
   * 切换账号
   *
   * @param accountId - 目标账号 ID
   * @returns 切换后的账号记录
   */
  async switchAccount(accountId: string): Promise<CodexAccountRecord> {
    const index = await this.readIndex();
    const account = index.accounts.find((item) => item.id === accountId);

    if (!account) {
      throw createError.accountNotFound(accountId);
    }

    const previousActiveId = index.currentAccountId;

    const tokens = await this.secretStore.getTokens(accountId);
    if (!tokens) {
      throw new AccountError(`Tokens missing for account ${account.email}`, {
        code: ErrorCode.AUTH_TOKEN_MISSING
      });
    }

    // 写入 auth.json
    await writeAuthFile({
      ...tokens,
      accountId: account.accountId ?? tokens.accountId
    });

    // 更新激活状态
    markActive(index, accountId);
    reconcileStatusBarSelections(index, accountId, previousActiveId);

    this.writeIndex(index);

    return index.accounts.find((item) => item.id === accountId)!;
  }

  /**
   * 移除账号
   */
  async removeAccount(accountId: string): Promise<void> {
    const index = await this.readIndex();
    index.accounts = index.accounts.filter((item) => item.id !== accountId);

    if (index.currentAccountId === accountId) {
      index.currentAccountId = undefined;
    }

    await this.secretStore.deleteTokens(accountId);
    this.writeIndex(index);
  }

  /**
   * 设置状态栏可见性
   *
   * @param accountId - 账号 ID
   * @param visible - 是否可见
   * @returns 更新后的账号记录
   */
  async setStatusBarVisibility(accountId: string, visible: boolean): Promise<CodexAccountRecord> {
    const index = await this.readIndex();
    const account = index.accounts.find((item) => item.id === accountId);

    if (!account) {
      throw createError.accountNotFound(accountId);
    }

    if (account.isActive) {
      account.showInStatusBar = false;
    } else if (visible) {
      const enabledCount = index.accounts.filter((item) => !item.isActive && item.showInStatusBar).length;

      if (enabledCount >= 2) {
        throw new AccountError("Only 2 extra accounts can be shown in the status popup", {
          code: ErrorCode.ACCOUNT_INVALID_DATA,
          i18nKey: "status.limitTip"
        });
      }
      account.showInStatusBar = true;
    } else {
      account.showInStatusBar = false;
    }

    account.updatedAt = Date.now();
    this.writeIndex(index);

    return account;
  }

  /**
   * 更新配额信息
   *
   * @param accountId - 账号 ID
   * @param quotaSummary - 配额摘要
   * @param quotaError - 配额错误信息
   * @param updatedTokens - 更新后的令牌
   * @param updatedPlanType - 更新后的计划类型
   * @returns 更新后的账号记录
   */
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
      throw createError.accountNotFound(accountId);
    }

    account.lastQuotaAt = Date.now();
    account.updatedAt = Date.now();
    account.quotaSummary = normalizeQuotaSummary(quotaSummary);
    account.quotaError = quotaError;
    account.dismissedHealthIssueKey = undefined;

    if (updatedPlanType) {
      account.planType = updatedPlanType;
    }

    const storedTokens = updatedTokens ?? (await this.secretStore.getTokens(accountId));
    const previousStoredAccountId = storedTokens?.accountId;
    const effectivePlanType = account.planType;
    if (!account.loginAt && storedTokens) {
      const effectiveTokens = storedTokens;
      if (effectiveTokens) {
        const claims = extractClaims(effectiveTokens.idToken, effectiveTokens.accessToken);
        account.loginAt = claims.loginAt ?? account.loginAt;
      }
    }

    if (storedTokens && shouldRepairWorkspaceMetadata(account, effectivePlanType)) {
      const claims = extractClaims(storedTokens.idToken, storedTokens.accessToken);
      const remoteProfile = await fetchRemoteAccountProfile(storedTokens).catch(() => undefined);
      const claimsAccountId = claims.accountId ?? account.accountId;
      if (didRemoteAccountMatchClaims(remoteProfile, claimsAccountId)) {
        const repairedName = sanitizeWorkspaceName(remoteProfile?.accountName, effectivePlanType);
        if (repairedName) {
          account.accountName = repairedName;
        }

        account.accountId = remoteProfile?.accountId ?? claimsAccountId ?? account.accountId;
        account.organizationId = claims.organizationId ?? account.organizationId;
        account.accountStructure = resolveAccountStructure(
          remoteProfile?.accountStructure,
          account.accountStructure,
          effectivePlanType,
          account.organizationId
        );
      }
    }

    if (storedTokens && (updatedTokens || account.accountId !== previousStoredAccountId)) {
      await this.secretStore.setTokens(accountId, {
        ...storedTokens,
        accountId: account.accountId ?? storedTokens.accountId
      });
    }

    this.writeIndex(index);

    return account;
  }

  /**
   * 同步激活账号状态 (从 auth.json)
   */
  async syncActiveAccountFromAuthFile(): Promise<void> {
    const auth = await readAuthFile();
    const index = await this.readIndex();
    const claims = auth ? extractClaims(auth.tokens.id_token, auth.tokens.access_token) : undefined;
    const derivedId = claims?.email
      ? buildAccountStorageId(claims.email, claims.accountId, claims.organizationId)
      : undefined;

    if (syncActiveAccountState(index, derivedId)) {
      this.writeIndex(index);
    }
  }

  /**
   * 打开 Codex Home 目录
   */
  async openCodexHome(): Promise<void> {
    const codexHome = process.env["CODEX_HOME"]?.trim()
      ? process.env["CODEX_HOME"].replace(/^['"]|['"]$/g, "")
      : path.join(os.homedir(), ".codex");

    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(path.join(codexHome, "auth.json")));
  }

  /**
   * 读取索引 (带缓存)
   */
  private async readIndex(): Promise<CodexAccountsIndex> {
    if (this.indexHealth.status === "corrupted_unrecoverable") {
      throw createError.storageWriteBlocked(
        "Accounts index is corrupted and must be restored before continuing."
      );
    }

    if (this.pendingSave) {
      return cloneIndex(this.pendingSave);
    }

    // 检查缓存是否有效
    if (this.cache) {
      const age = Date.now() - this.cache.timestamp;
      if (age < CACHE_TTL_MS) {
        return cloneIndex(this.cache.data);
      }
    }

    try {
      const snapshot = await this.readIndexSnapshot(this.indexPath);
      this.cache = {
        data: snapshot,
        timestamp: Date.now()
      };
      this.indexHealth = {
        ...this.indexHealth,
        status: this.indexHealth.status === "restored_from_backup" ? "restored_from_backup" : "healthy",
        availableBackups: await this.countAvailableBackups()
      };
      return cloneIndex(snapshot);
    } catch (cause) {
      if (isFileNotFoundError(cause)) {
        console.info("[codexAccounts] accounts index not found, using empty index");
        this.indexHealth = {
          status: "healthy",
          availableBackups: await this.countAvailableBackups()
        };
        this.cache = {
          data: createEmptyIndex(),
          timestamp: Date.now()
        };
        return cloneIndex(this.cache.data);
      }

      console.error("[codexAccounts] failed to read accounts index, attempting recovery:", cause);
      const restored = await this.tryRestoreFromBackups("backup", cause);
      if (restored) {
        return cloneIndex(restored);
      }

      this.cache = null;
      this.pendingSave = null;
      this.indexHealth = {
        status: "corrupted_unrecoverable",
        lastRestoreSource: this.indexHealth.lastRestoreSource,
        availableBackups: await this.countAvailableBackups(),
        lastErrorMessage: getErrorMessage(cause)
      };
      throw createError.storageIndexRecoveryFailed(this.indexPath, cause);
    }
  }

  private async readIndexForRecovery(): Promise<CodexAccountsIndex> {
    try {
      return await this.readIndex();
    } catch (error) {
      if (!isIndexHealthError(error)) {
        throw error;
      }

      const empty = createEmptyIndex();
      this.cache = {
        data: empty,
        timestamp: Date.now()
      };
      return cloneIndex(empty);
    }
  }

  /**
   * 写入索引 (带防抖)
   */
  private writeIndex(index: CodexAccountsIndex): void {
    this.assertWriteAllowed();
    const snapshot = cloneIndex(index);

    // 更新缓存
    this.cache = {
      data: snapshot,
      timestamp: Date.now()
    };
    this.isDirty = true;

    // 清除之前的定时器
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }

    // 设置新的防抖定时器
    this.pendingSave = snapshot;
    this.saveDebounceTimer = setTimeout(() => {
      void this.flushPendingSave();
    }, DEBOUNCE_DELAY_MS);
  }

  private async flushPendingSave(): Promise<void> {
    const snapshot = this.pendingSave;
    this.saveDebounceTimer = null;

    if (!snapshot) {
      return;
    }

    const persistTask = this.persistChain
      .catch(() => undefined)
      .then(async () => {
        await this.persistIndex(snapshot);
      });
    this.persistChain = persistTask;

    try {
      await persistTask;
      if (this.pendingSave === snapshot) {
        this.pendingSave = null;
      }
      if (!this.pendingSave) {
        this.isDirty = false;
      }
    } catch (error) {
      console.error("[codexAccounts] failed to persist accounts index:", error);
    }
  }

  private async persistIndex(index: CodexAccountsIndex): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.indexPath), { recursive: true });
      await this.backupCurrentIndex();
      await this.writeIndexAtomically(index);
      if (this.indexHealth.status === "corrupted_unrecoverable") {
        this.indexHealth = {
          status: "healthy",
          availableBackups: await this.countAvailableBackups()
        };
      } else {
        this.indexHealth = {
          ...this.indexHealth,
          availableBackups: await this.countAvailableBackups()
        };
      }
    } catch (cause) {
      throw createError.storageWriteFailed(this.indexPath, cause);
    }
  }

  /**
   * 持久化索引到文件 (同步模式，用于 dispose 时)
   */
  private persistIndexSync(index: CodexAccountsIndex): void {
    try {
      fsSync.mkdirSync(path.dirname(this.indexPath), { recursive: true });
      this.backupCurrentIndexSync();
      this.writeIndexAtomicallySync(index);
      if (this.indexHealth.status === "corrupted_unrecoverable") {
        this.indexHealth = {
          status: "healthy",
          availableBackups: countAvailableBackupsSync(this.indexPath)
        };
      } else {
        this.indexHealth = {
          ...this.indexHealth,
          availableBackups: countAvailableBackupsSync(this.indexPath)
        };
      }
    } catch (cause) {
      throw createError.storageWriteFailed(this.indexPath, cause);
    }
  }

  private assertWriteAllowed(): void {
    if (this.indexHealth.status === "corrupted_unrecoverable") {
      console.warn("[codexAccounts] blocked write because accounts index is corrupted");
      throw createError.storageWriteBlocked("Accounts index is corrupted. Restore accounts before writing again.");
    }
  }

  private async persistRecoveredIndex(
    index: CodexAccountsIndex,
    source: CodexAccountsRestoreResult["source"]
  ): Promise<void> {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    this.pendingSave = null;
    await fs.mkdir(path.dirname(this.indexPath), { recursive: true });
    await this.backupCurrentIndex();
    await this.writeIndexAtomically(index);
    this.isDirty = false;
    this.cache = {
      data: cloneIndex(index),
      timestamp: Date.now()
    };
    this.indexHealth = {
      status: source === "backup" ? "restored_from_backup" : "healthy",
      lastRestoreSource: source,
      availableBackups: await this.countAvailableBackups(),
      lastRecoveredAt: Date.now()
    };
  }

  private async readIndexSnapshot(filePath: string): Promise<CodexAccountsIndex> {
    const raw = await fs.readFile(filePath, "utf8");
    return parseAccountsIndex(raw, filePath);
  }

  private async tryRestoreFromBackups(
    source: CodexAccountsRestoreResult["source"],
    originalError?: unknown
  ): Promise<CodexAccountsIndex | undefined> {
    for (let slot = 1; slot <= INDEX_BACKUP_COUNT; slot += 1) {
      const backupPath = getBackupPath(this.indexPath, slot);
      try {
        const snapshot = await this.readIndexSnapshot(backupPath);
        console.warn(`[codexAccounts] restored accounts index from backup-${slot}`);
        await this.persistRecoveredIndex(snapshot, source);
        this.indexHealth = {
          ...this.indexHealth,
          status: "restored_from_backup",
          lastRestoreSource: "backup",
          lastErrorMessage: originalError ? getErrorMessage(originalError) : undefined
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

  private async countAvailableBackups(): Promise<number> {
    let count = 0;
    for (let slot = 1; slot <= INDEX_BACKUP_COUNT; slot += 1) {
      try {
        await fs.access(getBackupPath(this.indexPath, slot));
        count += 1;
      } catch {
        continue;
      }
    }
    return count;
  }

  private async backupCurrentIndex(): Promise<void> {
    const current = await this.readCurrentIndexForBackup();
    if (!current) {
      return;
    }

    console.info("[codexAccounts] creating accounts index backup");
    for (let slot = INDEX_BACKUP_COUNT; slot >= 2; slot -= 1) {
      const from = getBackupPath(this.indexPath, slot - 1);
      const to = getBackupPath(this.indexPath, slot);
      try {
        await fs.copyFile(from, to);
      } catch (error) {
        if (!isFileNotFoundError(error)) {
          console.error(`[codexAccounts] failed to rotate backup ${slot - 1} -> ${slot}:`, error);
        }
      }
    }

    await fs.writeFile(getBackupPath(this.indexPath, 1), current, "utf8");
  }

  private backupCurrentIndexSync(): void {
    const current = readCurrentIndexForBackupSync(this.indexPath);
    if (!current) {
      return;
    }

    for (let slot = INDEX_BACKUP_COUNT; slot >= 2; slot -= 1) {
      const from = getBackupPath(this.indexPath, slot - 1);
      const to = getBackupPath(this.indexPath, slot);
      try {
        fsSync.copyFileSync(from, to);
      } catch (error) {
        if (!isFileNotFoundError(error)) {
          console.error(`[codexAccounts] failed to rotate backup ${slot - 1} -> ${slot}:`, error);
        }
      }
    }

    fsSync.writeFileSync(getBackupPath(this.indexPath, 1), current, "utf8");
  }

  private async readCurrentIndexForBackup(): Promise<string | undefined> {
    try {
      const raw = await fs.readFile(this.indexPath, "utf8");
      parseAccountsIndex(raw, this.indexPath);
      return raw;
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        console.warn("[codexAccounts] skipped index backup because current index is unreadable");
      }
      return undefined;
    }
  }

  private async writeIndexAtomically(index: CodexAccountsIndex): Promise<void> {
    const serialized = JSON.stringify(index, null, 2);
    parseAccountsIndex(serialized, `${this.indexPath}${INDEX_TEMP_SUFFIX}`);
    const tempPath = `${this.indexPath}${INDEX_TEMP_SUFFIX}`;
    await fs.writeFile(tempPath, serialized, "utf8");
    await fs.rename(tempPath, this.indexPath);
  }

  private writeIndexAtomicallySync(index: CodexAccountsIndex): void {
    const serialized = JSON.stringify(index, null, 2);
    parseAccountsIndex(serialized, `${this.indexPath}${INDEX_TEMP_SUFFIX}`);
    const tempPath = `${this.indexPath}${INDEX_TEMP_SUFFIX}`;
    fsSync.writeFileSync(tempPath, serialized, "utf8");
    fsSync.renameSync(tempPath, this.indexPath);
  }
}

/**
 * 选择工作空间样式的标题
 */
function pickWorkspaceLikeTitle(candidates?: Array<string | undefined>, planType?: string): string | undefined {
  if (!candidates?.length) {
    return undefined;
  }

  const normalized = (candidates ?? [])
    .filter((item): item is string => Boolean(item?.trim()))
    .map((item) => item.trim());

  const preferred = normalized.find((item) => !isGenericPersonalWorkspaceName(item));
  if (preferred) {
    return preferred;
  }

  const fallback = normalized[0];
  return sanitizeWorkspaceName(fallback, planType);
}

/**
 * 推断账号结构类型
 */
function inferAccountStructure(planType?: string, organizationId?: string): string | undefined {
  if (organizationId) {
    return "organization";
  }
  if (planType && ["team", "business", "enterprise"].includes(planType.toLowerCase())) {
    return "team";
  }
  return "personal";
}

function resolveAccountStructure(
  remoteAccountStructure: string | undefined,
  existingAccountStructure: string | undefined,
  planType?: string,
  organizationId?: string
): string | undefined {
  if (remoteAccountStructure?.trim()) {
    return remoteAccountStructure;
  }

  const inferred = inferAccountStructure(planType, organizationId);
  if (!existingAccountStructure?.trim()) {
    return inferred;
  }

  const existing = existingAccountStructure.trim().toLowerCase();
  if (!inferred) {
    return existing;
  }

  if (existing === "organization" || inferred === "organization") {
    return inferred === "organization" ? inferred : existing;
  }

  if (isCollaborativeWorkspaceStructure(existing) || isCollaborativeWorkspaceStructure(inferred)) {
    return isCollaborativeWorkspaceStructure(inferred) ? inferred : existing;
  }

  return existing;
}

function shouldRepairWorkspaceMetadata(account: CodexAccountRecord, planType?: string): boolean {
  if (!account.accountName?.trim()) {
    return true;
  }

  const normalizedStructure = account.accountStructure?.trim().toLowerCase();
  const normalizedPlanType = planType?.trim().toLowerCase();
  if (!normalizedPlanType) {
    return false;
  }

  return ["team", "business", "enterprise"].includes(normalizedPlanType) && normalizedStructure === "personal";
}

function sanitizeWorkspaceName(name: string | undefined, planType?: string): string | undefined {
  const trimmed = name?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (isGenericPersonalWorkspaceName(trimmed) && !isPersonalLikePlan(planType)) {
    return undefined;
  }

  return trimmed;
}

function didRemoteAccountMatchClaims(
  remoteProfile: { accountId?: string } | undefined,
  claimsAccountId?: string
): boolean {
  if (!remoteProfile) {
    return false;
  }

  if (!claimsAccountId) {
    return true;
  }

  return !remoteProfile.accountId || remoteProfile.accountId === claimsAccountId;
}

function isCollaborativeWorkspaceStructure(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "team" || normalized === "workspace";
}

function isGenericPersonalWorkspaceName(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "personal" || normalized === "personal workspace" || normalized === "个人空间";
}

function isPersonalLikePlan(planType?: string): boolean {
  const normalized = planType?.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return ["free", "plus", "pro", "personal"].includes(normalized);
}

/**
 * 标记账号为激活状态
 */
function markActive(index: CodexAccountsIndex, accountId: string): void {
  index.currentAccountId = accountId;
  for (const account of index.accounts) {
    account.isActive = account.id === accountId;
  }
}

function syncActiveAccountState(index: CodexAccountsIndex, accountId: string | undefined): boolean {
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

function createEmptyIndex(): CodexAccountsIndex {
  return { accounts: [] };
}

function cloneIndex(index: CodexAccountsIndex): CodexAccountsIndex {
  const normalized: CodexAccountsIndex = {
    currentAccountId: index?.currentAccountId,
    accounts: Array.isArray(index?.accounts)
      ? index.accounts.map((account) => ({
          ...account,
          tags: normalizeAccountTags(account.tags),
          quotaSummary: normalizeQuotaSummary(account.quotaSummary)
        }))
      : []
  };
  return JSON.parse(JSON.stringify(normalized)) as CodexAccountsIndex;
}

function parseAccountsIndex(raw: string, filePath: string): CodexAccountsIndex {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidAccountsIndex(parsed)) {
      throw new Error("Invalid accounts index structure");
    }
    return cloneIndex(parsed as CodexAccountsIndex);
  } catch (cause) {
    throw createError.storageIndexCorrupted(filePath, cause);
  }
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

function getBackupPath(indexPath: string, slot: number): string {
  return indexPath.replace(/\.json$/i, `.backup-${slot}.json`);
}

function countAvailableBackupsSync(indexPath: string): number {
  let count = 0;
  for (let slot = 1; slot <= INDEX_BACKUP_COUNT; slot += 1) {
    if (fsSync.existsSync(getBackupPath(indexPath, slot))) {
      count += 1;
    }
  }
  return count;
}

function readCurrentIndexForBackupSync(indexPath: string): string | undefined {
  try {
    const raw = fsSync.readFileSync(indexPath, "utf8");
    parseAccountsIndex(raw, indexPath);
    return raw;
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      console.warn("[codexAccounts] skipped sync index backup because current index is unreadable");
    }
    return undefined;
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function isIndexHealthError(error: unknown): boolean {
  return (
    error instanceof StorageError &&
    (error.code === ErrorCode.STORAGE_INDEX_CORRUPTED ||
      error.code === ErrorCode.STORAGE_INDEX_RECOVERY_FAILED ||
      error.code === ErrorCode.STORAGE_WRITE_BLOCKED)
  );
}

/**
 * 协调状态栏选择
 */
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

/**
 * 判断是否默认启用状态栏
 */
function shouldEnableStatusBarByDefault(accounts: CodexAccountRecord[], accountId: string): boolean {
  const enabledCount = accounts.filter(
    (item) => item.id !== accountId && !item.isActive && item.showInStatusBar
  ).length;
  return enabledCount < 2;
}

function toSharedAccountJson(account: CodexAccountRecord, tokens: CodexTokens): SharedCodexAccountJson {
  return {
    id: account.id,
    email: account.email,
    auth_mode: "oauth",
    user_id: account.userId,
    plan_type: account.planType,
    account_id: account.accountId ?? null,
    organization_id: account.organizationId ?? null,
    account_name: account.accountName ?? null,
    account_structure: account.accountStructure ?? null,
    tokens: {
      id_token: tokens.idToken,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      account_id: account.accountId ?? tokens.accountId ?? null
    },
    quota: toSharedQuota(account.quotaSummary),
    quota_error: account.quotaError
      ? {
          code: account.quotaError.code,
          message: account.quotaError.message,
          timestamp: account.quotaError.timestamp
        }
      : null,
    tags: account.tags?.length ? [...account.tags] : null,
    created_at: Math.floor(account.createdAt / 1000),
    last_used: Math.floor(account.updatedAt / 1000)
  };
}

function toSharedQuota(summary?: CodexQuotaSummary): SharedCodexAccountJson["quota"] {
  if (!summary) {
    return null;
  }

  return {
    hourly_percentage: summary.hourlyPercentage,
    hourly_reset_time: summary.hourlyResetTime,
    hourly_window_minutes: summary.hourlyWindowMinutes,
    hourly_window_present: summary.hourlyWindowPresent,
    weekly_percentage: summary.weeklyPercentage,
    weekly_reset_time: summary.weeklyResetTime,
    weekly_window_minutes: summary.weeklyWindowMinutes,
    weekly_window_present: summary.weeklyWindowPresent,
    code_review_percentage: summary.codeReviewPercentage,
    code_review_reset_time: summary.codeReviewResetTime,
    code_review_window_minutes: summary.codeReviewWindowMinutes,
    code_review_window_present: summary.codeReviewWindowPresent,
    raw_data: summary.rawData ?? null
  };
}

function previewSharedEntry(entry: SharedCodexAccountJson): { storageId?: string; email?: string } {
  const restoredTokens = restoreSharedTokens(entry);
  const claims = extractClaims(restoredTokens.idToken, restoredTokens.accessToken);
  if (!claims.email) {
    throw new AccountError("Shared account JSON does not include a valid email in tokens", {
      code: ErrorCode.ACCOUNT_INVALID_DATA
    });
  }

  return {
    storageId: buildAccountStorageId(claims.email, claims.accountId, claims.organizationId),
    email: claims.email
  };
}

function restoreSharedTokens(entry: SharedCodexAccountJson): CodexTokens {
  const idToken = sanitizeOptionalValue(entry.tokens?.id_token);
  const accessToken = sanitizeOptionalValue(entry.tokens?.access_token);
  if (!idToken || !accessToken) {
    throw new AccountError("Shared account JSON does not include valid tokens", {
      code: ErrorCode.AUTH_TOKEN_MISSING
    });
  }

  return {
    idToken,
    accessToken,
    refreshToken: sanitizeOptionalValue(entry.tokens?.refresh_token),
    accountId: sanitizeOptionalValue(entry.tokens?.account_id) ?? sanitizeOptionalValue(entry.account_id)
  };
}

function normalizeAccountTags(
  tags: string[] | null | undefined | unknown,
  fallback?: string[] | null | undefined
): string[] | undefined {
  const source = Array.isArray(tags) ? tags : Array.isArray(fallback) ? fallback : [];
  const normalized = Array.from(
    new Map(
      source
        .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
        .filter(Boolean)
        .slice(0, 20)
        .map((tag) => [tag.toLowerCase(), tag.slice(0, 24)])
    ).values()
  ).slice(0, 10);

  return normalized.length ? normalized : undefined;
}

function fromSharedQuota(quota: NonNullable<SharedCodexAccountJson["quota"]>): CodexQuotaSummary {
  return {
    hourlyPercentage: normalizeQuotaNumber(quota.hourly_percentage),
    hourlyResetTime: normalizeOptionalNumber(quota.hourly_reset_time),
    hourlyWindowMinutes: normalizeOptionalNumber(quota.hourly_window_minutes),
    hourlyWindowPresent: Boolean(quota.hourly_window_present),
    weeklyPercentage: normalizeQuotaNumber(quota.weekly_percentage),
    weeklyResetTime: normalizeOptionalNumber(quota.weekly_reset_time),
    weeklyWindowMinutes: normalizeOptionalNumber(quota.weekly_window_minutes),
    weeklyWindowPresent: Boolean(quota.weekly_window_present),
    codeReviewPercentage: normalizeQuotaNumber(quota.code_review_percentage),
    codeReviewResetTime: normalizeOptionalNumber(quota.code_review_reset_time),
    codeReviewWindowMinutes: normalizeOptionalNumber(quota.code_review_window_minutes),
    codeReviewWindowPresent: Boolean(quota.code_review_window_present),
    rawData: quota.raw_data ?? undefined
  };
}

function fromSharedQuotaError(
  quotaError: SharedCodexAccountJson["quota_error"]
): CodexAccountRecord["quotaError"] | undefined {
  if (!quotaError?.message) {
    return undefined;
  }

  return {
    code: sanitizeOptionalValue(quotaError.code),
    message: quotaError.message,
    timestamp: normalizeEpochSeconds(quotaError.timestamp) ?? Math.floor(Date.now() / 1000)
  };
}

function sanitizeOptionalValue(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value : value == null ? undefined : String(value);
  const trimmed = normalized?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeEpochMs(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function normalizeEpochSeconds(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return value > 1_000_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
}

function normalizeOptionalNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeQuotaNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
