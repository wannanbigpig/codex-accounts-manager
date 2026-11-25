/**
 * 账号存储仓库
 *
 * 使用跨进程文件锁保护账号索引与全局凭证。
 */

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "node:crypto";
import { recordQuotaHistory } from "../domain/quotaHistory";
import { isAvailableResetCredit } from "../domain/resetCredits";
import * as vscode from "vscode";
import { isDeepStrictEqual } from "util";
import { SecretStore } from "./secrets";
import { sameTokenSnapshot, tryWithCredentialLock, withCredentialLock } from "./credentialLocks";
import { applyIndexChanges, createEmptyIndex, markActive, syncActiveAccountState } from "./accountsIndex";
import {
  addAccountTags as addAccountTagsToIndex,
  dismissAccountHealthIssue,
  removeAccountFromIndex,
  removeAccountTags as removeAccountTagsFromIndex,
  setAccountTags as setAccountTagsOnIndex,
  setStatusBarVisibility as setStatusBarVisibilityOnIndex,
  switchActiveAccount
} from "./accountMutations";
import {
  applyQuotaUpdate,
  applyRemoteProfileFromTokens,
  shouldAttemptRemoteProfileRepair,
  syncLoginAtFromTokens
} from "./accountProfileMaintenance";
import {
  buildAccountRecordDraft,
  clearDerivedWorkspaceData,
  reconcileStatusBarSelections,
  sameAccountWorkspace,
  type AccountWorkspace
} from "./accountMetadata";
import { previewSharedEntry, restoreSharedTokens, toSharedAccountJson } from "./sharedAccounts";
import {
  applySharedAccountEntry,
  createSharedImportIssue,
  previewSharedAccountsImportEntries,
  requireSharedAccountEntry,
  toSharedEntries
} from "./sharedAccountsImport";
import { countAvailableBackups, isFileNotFoundError, readIndexSnapshot } from "./accountsPersistence";
import {
  isIndexHealthError,
  markUnrecoverableIndex,
  persistRecoveredIndex,
  readIndexForRecovery,
  tryRestoreFromBackups
} from "./accountsRecovery";
import { createAccountsRepositoryState } from "./accountsRepositoryState";
import { persistIndexWithBackups } from "./accountsWriteCoordinator";
import { getAuthJsonPath, readAuthFile, writeAuthFile } from "../codex";
import { needsRefresh, refreshTokens, TOKEN_REFRESH_SKEW_SECONDS } from "../auth/oauth";
import { createKeyedMutex } from "../utils/concurrency";
import {
  CodexAccountRecord,
  CodexAuthFile,
  CodexAccountsIndex,
  CodexAccountsRestoreResult,
  CodexImportPreviewSummary,
  CodexImportResultIssue,
  CodexImportResultSummary,
  CodexIndexHealthSummary,
  CodexQuotaSummary,
  CodexResetCreditRedemption,
  CodexResetCreditsSnapshot,
  CodexTokens,
  SharedCodexAccountJson
} from "../core/types";
import { fetchRemoteAccountProfile } from "../services/profile";
import { workspaceKind } from "../services/workspaceIdentity";
import { clearQuotaCacheForAccount, type ResetCreditRedemptionOutcome } from "../services/quota";
import {
  clearSubscriptionRetryPending,
  fetchSubscriptionStatus,
  markSubscriptionRetryPending,
  shouldAttemptSubscriptionRefresh,
  type SubscriptionStatusSnapshot
} from "../services/subscription";
import { conflictsWithAccessTokenIdentity, resolveAccountStorageId } from "../utils/accountIdentity";
import { decodeJwtPayload, extractClaims, isTokenExpired } from "../utils/jwt";
import { getQuotaIssueKind } from "../utils/quotaIssue";
import { normalizePlanType } from "../utils/quotaLabels";
import { AccountError, StorageError, createError, ErrorCode } from "../core/errors";
import {
  AideckMirrorTokenSnapshot,
  listAideckCodexSharedAccounts,
  mirrorAideckCodexAccount,
  mirrorAideckCurrentAccount,
  readAideckCodexSharedAccount,
  removeAideckCodexAccount,
  readAideckCodexTokens
} from "./aideckCodexStorage";

const INDEX_FILE = "accounts-index.json";
const INDEX_TEMP_SUFFIX = ".tmp";
const INDEX_BACKUP_COUNT = 3;

/**
 * 账号存储仓库
 *
 * 提供账号数据的持久化和缓存管理
 */
/** getTokens 内存缓存 TTL（避免 Dashboard 刷新时重复读 Keychain） */
const TOKEN_CACHE_TTL_MS = 30_000;

type TokenCacheEntry = {
  tokens: CodexTokens | undefined;
  cachedAt: number;
};

type AccountUpsertOptions = {
  restoreSource?: CodexAccountsRestoreResult["source"];
  addedVia?: CodexAccountRecord["addedVia"];
  sharedEntry?: SharedCodexAccountJson;
  activeAuth?: CodexAuthFile;
  beforeSave?: () => void;
};

type GuardedAccountUpsert = AccountUpsertOptions & { mirrorSourceId: string };

export class AccountsRepository {
  private readonly secretStore: SecretStore;
  private readonly indexPath: string;
  private readonly credentialLockDirectory: string;
  private readonly state = createAccountsRepositoryState();
  private readonly indexBaselines = new WeakMap<CodexAccountsIndex, CodexAccountsIndex>();
  /** 按账号串行化切号/刷新，避免并发刷新同一账号 token */
  private readonly accountMutex = createKeyedMutex();
  /** getTokens 内存缓存，减少 SecretStore/Keychain 重复读取 */
  private readonly tokenCache = new Map<string, TokenCacheEntry>();
  /** 同账号订阅刷新复用，避免较晚完成的旧请求覆盖新结果。 */
  private readonly subscriptionRefreshes = new Map<string, { force: boolean; task: Promise<void> }>();

  /** 任何 token 写入后清空整个缓存，下次 getTokens 重新从 SecretStore 读取 */
  private invalidateTokenCache(): void {
    if (this.tokenCache.size > 0) {
      this.tokenCache.clear();
    }
  }

  constructor(private readonly context: vscode.ExtensionContext) {
    this.credentialLockDirectory = path.join(context.globalStorageUri.fsPath, "credential-locks");
    this.secretStore = new SecretStore(context.secrets, this.credentialLockDirectory);
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
      await this.syncFromAideckMirror();
    } catch (cause) {
      if (isIndexHealthError(cause)) {
        console.error("[codexAccounts] accounts index init failed:", cause);
        return;
      }
      throw cause;
    }
  }

  async syncFromAideckMirror(): Promise<CodexAccountRecord[]> {
    const sharedAccounts = await listAideckCodexSharedAccounts();
    if (sharedAccounts.length === 0) {
      return [];
    }

    let index: CodexAccountsIndex;
    try {
      index = await this.loadIndex();
    } catch (error) {
      if (isIndexHealthError(error)) {
        return [];
      }
      throw error;
    }

    const existingIds = new Set(index.accounts.map((account) => account.id));
    const imported: CodexAccountRecord[] = [];
    for (const { entry, sourceId } of sharedAccounts) {
      let storageId: string | undefined;
      try {
        storageId = previewSharedEntry(entry, index.accounts).storageId;
      } catch {
        continue;
      }
      if (!storageId || existingIds.has(storageId)) {
        continue;
      }
      const account = await this.upsertFromTokensInternal(restoreSharedTokens(entry), false, {
        addedVia: "json",
        mirrorSourceId: sourceId
      });
      if (account) {
        imported.push(account);
        existingIds.add(account.id);
      }
    }

    if (imported.length > 0) {
      console.info(`[codexAccounts] imported ${imported.length} account(s) from Aideck mirror`);
    }
    return imported;
  }

  /**
   * 清理资源
   */
  dispose(): void {
    this.invalidateTokenCache();
  }

  /**
   * 获取所有账号列表
   */
  async listAccounts(): Promise<CodexAccountRecord[]> {
    try {
      return (await this.loadIndex()).accounts;
    } catch (error) {
      if (isIndexHealthError(error)) {
        return [];
      }
      throw error;
    }
  }

  async runBackgroundQuotaBatch(operation: () => Promise<void>): Promise<void> {
    await tryWithCredentialLock(this.credentialLockDirectory, "background-quota-batch", operation);
  }

  async getDashboardAccountOrder(): Promise<readonly string[]> {
    try {
      return (await this.loadIndex()).dashboardAccountOrder ?? [];
    } catch (error) {
      if (isIndexHealthError(error)) {
        return [];
      }
      throw error;
    }
  }

  async moveDashboardAccount(id: string, targetId: string, after: boolean): Promise<void> {
    await this.changeIndex((index) => {
      const fallback = [...index.accounts].sort((a, b) => b.createdAt - a.createdAt || a.email.localeCompare(b.email));
      const order = [...new Set([...(index.dashboardAccountOrder ?? []), ...fallback.map((account) => account.id)])];
      if (id === targetId || !order.includes(id) || !order.includes(targetId)) {
        return;
      }
      order.splice(order.indexOf(id), 1);
      order.splice(order.indexOf(targetId) + Number(after), 0, id);
      index.dashboardAccountOrder = order;
    });
  }

  /**
   * 获取单个账号
   */
  async getAccount(accountId: string): Promise<CodexAccountRecord | undefined> {
    try {
      return (await this.loadIndex()).accounts.find((item) => item.id === accountId);
    } catch (error) {
      if (isIndexHealthError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async getIndexHealthSummary(): Promise<CodexIndexHealthSummary> {
    try {
      await this.loadIndex();
    } catch (error) {
      if (!isIndexHealthError(error)) {
        throw error;
      }
    }

    return {
      ...this.state.indexHealth,
      availableBackups: await countAvailableBackups(this.indexPath, INDEX_BACKUP_COUNT)
    };
  }

  async restoreIndexFromLatestBackup(): Promise<CodexAccountsRestoreResult> {
    const restored = await this.withIndexLock(() => this.tryRestoreFromBackups("backup"));
    if (!restored) {
      throw createError.storageIndexRecoveryFailed(this.indexPath, this.state.indexHealth.lastErrorMessage);
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

    if (!auth.tokens?.id_token || !auth.tokens.access_token) {
      throw new AccountError("Current auth.json does not include valid tokens", {
        code: ErrorCode.ACCOUNT_INVALID_DATA
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
        restoreSource: "auth_json",
        activeAuth: auth
      }
    );

    return {
      source: "auth_json",
      restoredCount: 1,
      restoredEmails: [restored.email]
    };
  }

  async restoreAccountsFromSharedJson(input: unknown): Promise<CodexAccountsRestoreResult> {
    const restored = await this.importSharedAccountsInternal(input, { restoreSource: "shared_json" });

    return {
      source: "shared_json",
      restoredCount: restored.length,
      restoredEmails: restored.map((account) => account.email)
    };
  }

  /**
   * 获取账号的令牌
   */
  async getTokens(
    accountId: string,
    options: { syncExternal?: boolean; bypassCache?: boolean } = {}
  ): Promise<CodexTokens | undefined> {
    try {
      // 内存缓存命中直接返回，避免 Dashboard 刷新时重复读 Keychain
      const cached = this.tokenCache.get(accountId);
      if (!options.bypassCache && cached && Date.now() - cached.cachedAt < TOKEN_CACHE_TTL_MS) {
        return cached.tokens;
      }

      const storedTokens = await this.secretStore.getTokens(accountId);
      this.tokenCache.set(accountId, { tokens: storedTokens, cachedAt: Date.now() });

      if (options.syncExternal === false) {
        return storedTokens;
      }

      const index = await this.loadIndex();
      const account = index.accounts.find((item) => item.id === accountId);
      if (!account) {
        this.tokenCache.delete(accountId);
        return undefined;
      }

      const aideckTokens = await readAideckCodexTokens(accountId);
      const mergedTokens = mergeExternalTokens(storedTokens, aideckTokens, account);

      if (!mergedTokens) {
        return storedTokens;
      }

      if (!storedTokens || shouldSyncTokensFromAuthFile(storedTokens, mergedTokens)) {
        const saved = await this.secretStore.setTokens(accountId, mergedTokens, {
          expectedTokens: storedTokens,
          beforeSave: () => this.hasSavedAccount(accountId),
          afterSave: async (previous) => {
            if (previous) {
              try {
                await this.updateActiveAuth(accountId, mergedTokens, previous, "mirror");
              } catch {
                // Reading a mirror can still supply credentials when auth.json is on a read-only mount.
                console.warn("[codexAccounts] could not synchronize adopted credentials to auth.json");
              }
            }
          }
        });
        this.invalidateTokenCache();
        clearQuotaCacheForAccount(accountId);
        if (!saved) {
          return this.secretStore.getTokens(accountId);
        }
      }

      return mergedTokens;
    } catch (cause) {
      throw new StorageError(`Failed to get tokens for ${accountId}`, {
        code: ErrorCode.STORAGE_SECRET_ACCESS_FAILED,
        cause
      });
    }
  }

  async getFreshTokens(
    accountId: string,
    options: {
      force?: boolean;
      expectedTokens?: CodexTokens;
      skewSeconds?: number;
      /** Reject an incompatible OAuth result before it reaches any credential store. */
      validateRefreshedTokens?: (replacement: CodexTokens, previous: CodexTokens) => void;
    } = {}
  ): Promise<CodexTokens | undefined> {
    return withCredentialLock(this.credentialLockDirectory, `refresh:${accountId}`, async (assertHeld) => {
      const snapshot = await this.getTokens(accountId, { bypassCache: true });
      if (!snapshot?.accessToken) {
        return undefined;
      }
      const force = options.force && (!options.expectedTokens || sameTokenSnapshot(snapshot, options.expectedTokens));
      if (!force && !needsRefresh(snapshot.accessToken, options.skewSeconds ?? TOKEN_REFRESH_SKEW_SECONDS)) {
        return snapshot;
      }
      if (!snapshot.refreshToken) {
        throw new AccountError("Refresh token missing", { code: ErrorCode.AUTH_TOKEN_MISSING });
      }
      let refreshed: CodexTokens;
      try {
        refreshed = await refreshTokens(snapshot.refreshToken, snapshot.idToken);
      } catch (error) {
        const latest = await this.secretStore.getTokens(accountId);
        this.invalidateTokenCache();
        if (latest && !sameTokenSnapshot(snapshot, latest) && !needsRefresh(latest.accessToken)) {
          return latest;
        }
        throw error;
      }
      assertHeld();
      const replacement = { ...snapshot, ...refreshed, accountId: refreshed.accountId ?? snapshot.accountId };
      options.validateRefreshedTokens?.(replacement, snapshot);
      await this.updateTokens(accountId, replacement, snapshot);
      return this.getTokens(accountId, { bypassCache: true, syncExternal: false });
    });
  }

  async updateTokens(
    accountId: string,
    tokens: CodexTokens,
    expectedTokens?: CodexTokens
  ): Promise<CodexAccountRecord> {
    const index = await this.readIndexForEdit();
    const account = index.accounts.find((item) => item.id === accountId);

    if (!account) {
      throw createError.accountNotFound(accountId);
    }

    const effectiveTokens = {
      ...tokens,
      accountId: expectedTokens && tokens.accountId === expectedTokens.accountId
        ? account.accountId ?? tokens.accountId
        : tokens.accountId ?? account.accountId
    };

    const saved = await this.secretStore.setTokens(accountId, effectiveTokens, {
      ...(expectedTokens ? { expectedTokens } : {}),
      beforeSave: () => this.hasSavedAccount(accountId),
      afterSave: async (previous) => {
        this.invalidateTokenCache();
        clearQuotaCacheForAccount(accountId);
        if (effectiveTokens.accountId && effectiveTokens.accountId !== account.accountId) {
          if (account.accountId) {
            clearDerivedWorkspaceData(account);
          }
          account.accountId = effectiveTokens.accountId;
          account.updatedAt = Date.now();
        }

        if (getQuotaIssueKind(account.quotaError) === "auth") {
          account.quotaError = undefined;
          account.dismissedHealthIssueKey = undefined;
          account.updatedAt = Date.now();
        }

        await this.updateActiveAuth(accountId, effectiveTokens, previous);
        await this.writeIndex(index, accountId);
      }
    });
    if (!saved) {
      this.invalidateTokenCache();
    }

    return account;
  }

  async refreshAccountProfileMetadata(accountId: string): Promise<CodexAccountRecord> {
    const account = await this.getAccount(accountId);
    if (!account) {
      throw createError.accountNotFound(accountId);
    }

    const tokens = await this.getTokens(accountId, { bypassCache: true });
    if (!tokens) {
      throw new AccountError(`Tokens missing for account ${account.email}`, {
        code: ErrorCode.AUTH_TOKEN_MISSING
      });
    }

    const remoteProfile = await fetchRemoteAccountProfile(tokens, {
      forceRefresh: true,
      preferredOrganizationId: account.organizationId,
      preferredAccountName: account.accountName,
      preferredAccountStructure: account.accountStructure
    });
    if (!remoteProfile) {
      throw new AccountError("The account profile did not contain a verified matching Codex workspace", {
        code: ErrorCode.ACCOUNT_INVALID_DATA
      });
    }

    return this.secretStore.withTokenWrite(accountId, async (currentTokens) => {
      if (!sameTokenSnapshot(currentTokens, tokens)) {
        throw new AccountError("Codex credentials changed during account info sync", { code: ErrorCode.ACCOUNT_INVALID_DATA });
      }
      return this.changeIndex(async (index) => {
        const latest = index.accounts.find((item) => item.id === accountId);
        if (!latest || !sameAccountWorkspace(latest, account)) {
          throw new AccountError("Codex workspace changed during account info sync", { code: ErrorCode.ACCOUNT_INVALID_DATA });
        }
        if (applyRemoteProfileFromTokens({
          account: latest,
          tokens,
          remoteProfile,
          planType: latest.planType,
          allowAccountIdRepair: true,
          preservePlanType: true
        })) {
          if (!sameAccountWorkspace(latest, account)) {
            clearQuotaCacheForAccount(accountId);
          }
          latest.updatedAt = Date.now();
          latest.dismissedHealthIssueKey = undefined;
          await mirrorAideckCodexAccount(latest, tokens);
        }
        return latest;
      });
    });
  }

  async dismissHealthIssue(accountId: string, issueKey?: string): Promise<CodexAccountRecord> {
    const index = await this.readIndexForEdit();
    const account = dismissAccountHealthIssue(index, accountId, issueKey, Date.now());
    if (!account) {
      throw createError.accountNotFound(accountId);
    }

    await this.writeIndex(index, accountId);
    return account;
  }

  async setAccountTags(accountId: string, tags: string[]): Promise<CodexAccountRecord> {
    return this.changeIndex(async (index) => {
      const account = setAccountTagsOnIndex(index, accountId, tags, Date.now());
      if (!account) {
        throw createError.accountNotFound(accountId);
      }
      await mirrorAideckCodexAccount(account, await this.secretStore.getTokens(accountId));
      return account;
    });
  }

  async addAccountTags(accountIds: string[], tags: string[]): Promise<CodexAccountRecord[]> {
    return this.changeIndex(async (index) => {
      const updated = addAccountTagsToIndex(index, accountIds, tags, Date.now());
      await Promise.all(
        updated.map(async (account) => mirrorAideckCodexAccount(account, await this.secretStore.getTokens(account.id)))
      );
      return updated;
    });
  }

  async removeAccountTags(accountIds: string[], tags: string[]): Promise<CodexAccountRecord[]> {
    return this.changeIndex(async (index) => {
      const updated = removeAccountTagsFromIndex(index, accountIds, tags, Date.now());
      await Promise.all(
        updated.map(async (account) => mirrorAideckCodexAccount(account, await this.secretStore.getTokens(account.id)))
      );
      return updated;
    });
  }

  async previewSharedAccountsImport(input: unknown): Promise<CodexImportPreviewSummary> {
    const entries = toSharedEntries(input);
    // Preview must not trigger automatic index recovery or write a backup.
    const existing = await readIndexSnapshot(this.indexPath).catch(() => createEmptyIndex());
    return previewSharedAccountsImportEntries(entries, new Set(existing.accounts.map((account) => account.id)), existing.accounts);
  }

  /**
   * 插入或更新账号 (从令牌)
   *
   * @param tokens - 认证令牌
   * @param forceActive - 是否强制设为激活状态
   * @returns 账号记录
   */
  async upsertFromTokens(tokens: CodexTokens, forceActive = false, beforeSave?: () => void): Promise<CodexAccountRecord> {
    return this.upsertFromTokensInternal(tokens, forceActive, { beforeSave });
  }

  async reauthorizeAccount(
    accountId: string,
    authorize: () => Promise<CodexTokens | undefined>,
    beforeSave?: () => void
  ): Promise<CodexAccountRecord | undefined> {
    const index = await this.loadIndex();
    if (!index.accounts.some((account) => account.id === accountId)) {
      throw createError.accountNotFound(accountId);
    }
    const stored = await this.secretStore.getTokens(accountId);
    const auth = await readAuthFile();
    const wasActive = auth && accountIdFromAuth(auth, index.accounts) === accountId
      ? tokensFromAuth(auth, stored?.accountId) : undefined;
    const tokens = await authorize();
    if (!tokens) {
      return undefined;
    }

    const claims = extractClaims(tokens.idToken, tokens.accessToken);
    const email = claims.email;
    if (!email) {
      throw new AccountError("Unable to extract email from id_token", { code: ErrorCode.ACCOUNT_INVALID_DATA });
    }
    if (conflictsWithAccessTokenIdentity(claims, tokens.accessToken)) {
      throw new AccountError("Authorized tokens disagree on the Codex user or workspace", { code: ErrorCode.ACCOUNT_INVALID_DATA });
    }
    return this.secretStore.withTokenWrite(accountId, (previous, save) =>
      this.withAuthLock((assertHeld) => this.changeIndex(async (latest) => {
        const account = latest.accounts.find((item) => item.id === accountId);
        if (!account) {
          throw createError.accountNotFound(accountId);
        }
        const incoming = { ...tokens, accountId: account.accountId ?? tokens.accountId ?? claims.accountId };
        const currentAuth = await readAuthFile();
        const current = currentAuth && accountIdFromAuth(currentAuth, latest.accounts) === accountId
          ? tokensFromAuth(currentAuth, previous?.accountId)
          : undefined;
        const active = current !== undefined && (current.accountId ?? incoming.accountId) === incoming.accountId;
        if (
          shouldKeepReauthorizedTokens(previous, stored, incoming) ||
          (active && shouldKeepReauthorizedTokens(current, wasActive ?? stored, incoming))
        ) {
          this.invalidateTokenCache();
          return undefined;
        }

        assertReauthorizationIdentity(account, previous ?? stored, claims, email, tokens.accountId);
        const renamed = account.email !== email;
        if (renamed && latest.accounts.some((item) =>
          item.id !== accountId && item.email.toLowerCase() === email.toLowerCase() &&
          reauthorizationWorkspaceMayOverlap(item, account)
        )) {
          throw new AccountError("This email is already saved for the same Codex workspace", { code: ErrorCode.ACCOUNT_INVALID_DATA });
        }
        beforeSave?.();
        await save(incoming);
        this.invalidateTokenCache();
        clearQuotaCacheForAccount(accountId);
        if (active && !sameTokenSnapshot(current, incoming)) {
          assertHeld();
          await writeAuthFile(incoming);
          await mirrorAideckCurrentAccount(accountId);
        }
        account.email = email;
        account.userId ??= claims.userId;
        account.accountId ??= incoming.accountId;
        account.organizationId ??= claims.organizationId;
        account.loginAt = claims.loginAt ?? account.loginAt;
        account.authProvider = claims.authProvider ?? account.authProvider;
        account.updatedAt = Date.now();
        await mirrorAideckCodexAccount(account, incoming);
        return { ...account, isActive: active };
      }))
    );
  }

  private upsertFromTokensInternal(
    tokens: CodexTokens,
    forceActive: boolean,
    options: GuardedAccountUpsert
  ): Promise<CodexAccountRecord | undefined>;
  private upsertFromTokensInternal(
    tokens: CodexTokens,
    forceActive?: boolean,
    options?: AccountUpsertOptions & { mirrorSourceId?: never }
  ): Promise<CodexAccountRecord>;
  private async upsertFromTokensInternal(
    tokens: CodexTokens,
    forceActive = false,
    options: AccountUpsertOptions & {
      mirrorSourceId?: string;
    } = {}
  ): Promise<CodexAccountRecord | undefined> {
    const claims = extractClaims(tokens.idToken, tokens.accessToken);
    if (!claims.email) {
      throw new AccountError("Unable to extract email from id_token", {
        code: ErrorCode.ACCOUNT_INVALID_DATA
      });
    }
    const claimsWithEmail = {
      ...claims,
      email: claims.email
    };
    const savedIndex = options.restoreSource ? await this.readIndexForRecovery() : await this.loadIndex();
    const id = resolveAccountStorageId(claimsWithEmail, savedIndex.accounts);

    // 异步获取远程配置，不阻塞主要流程
    let remoteProfile;
    try {
      remoteProfile = await fetchRemoteAccountProfile(tokens);
    } catch {
      remoteProfile = undefined;
    }

    return this.secretStore.withTokenWrite(id, async (_previous, save) => {
      const index = options.restoreSource ? await this.readIndexForRecovery() : await this.readIndexForEdit();
      const existing = index.accounts.find((item) => item.id === id);
      let sharedEntry = options.sharedEntry;
      if (options.mirrorSourceId !== undefined) {
        if (existing) {
          return undefined;
        }
        // The startup scan and profile request may have overlapped a deletion or credential rotation.
        sharedEntry = await readAideckCodexSharedAccount(options.mirrorSourceId);
        if (!sharedEntry || !sameTokenSnapshot(tokens, restoreSharedTokens(sharedEntry))) {
          return undefined;
        }
      }
      const account = buildAccountRecordDraft({
        storageId: id,
        claims: claimsWithEmail,
        tokens,
        existing,
        existingAccounts: index.accounts,
        remoteProfile,
        addedVia: options.addedVia ?? "oauth",
        forceActive,
        now: Date.now()
      });

      index.accounts = index.accounts.filter((item) => item.id !== id);
      index.accounts.push(account);

      if (sharedEntry) {
        applySharedAccountEntry(account, sharedEntry);
      }

      const storedTokens = { ...tokens, accountId: account.accountId ?? tokens.accountId };
      const saveCredentials = async () => {
        options.beforeSave?.();
        await save(storedTokens);
        this.invalidateTokenCache();
        clearQuotaCacheForAccount(id);
      };
      const persist = () =>
        options.restoreSource
          ? this.persistRecoveredIndex(index, options.restoreSource, id)
          : this.writeIndex(index, id);

      await saveCredentials();
      if (forceActive) {
        await this.withAuthLock(async () => {
          if (!options.activeAuth || isDeepStrictEqual(options.activeAuth, await readAuthFile())) {
            const previousActiveId = index.currentAccountId;
            markActive(index, id);
            reconcileStatusBarSelections(index, id, previousActiveId);
            await mirrorAideckCurrentAccount(id);
          } else {
            account.isActive = false;
          }
          await persist();
        });
      } else {
        await persist();
      }
      return account;
    });
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

    if (!auth.tokens?.id_token || !auth.tokens.access_token) {
      throw new AccountError("Current auth.json does not include valid tokens", {
        code: ErrorCode.ACCOUNT_INVALID_DATA
      });
    }

    return this.upsertFromTokensInternal(
      {
        idToken: auth.tokens.id_token,
        accessToken: auth.tokens.access_token,
        refreshToken: auth.tokens.refresh_token,
        accountId: auth.tokens.account_id
      },
      true,
      {
        addedVia: "local",
        activeAuth: auth
      }
    );
  }

  async exportSharedAccounts(accountIds: string[]): Promise<SharedCodexAccountJson[]> {
    const uniqueIds = Array.from(new Set(accountIds));
    if (uniqueIds.length === 0) {
      return [];
    }

    const index = await this.loadIndex();
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

  async importSharedAccounts(input: unknown): Promise<CodexAccountRecord[]> {
    return this.importSharedAccountsInternal(input);
  }

  async importSharedAccountsWithSummary(input: unknown): Promise<CodexImportResultSummary> {
    const entries = toSharedEntries(input);
    const preview = await this.previewSharedAccountsImport(entries);
    const failures: CodexImportResultIssue[] = [];
    const importedEmails: string[] = [];
    let successCount = 0;

    for (const [index, entry] of entries.entries()) {
      try {
        const imported = await this.importSharedAccountsInternal(entry);
        const first = imported[0];
        if (!first) {
          failures.push(createSharedImportIssue(entry, index, "Import returned no account"));
          continue;
        }
        successCount += 1;
        importedEmails.push(first.email);
      } catch (error) {
        failures.push(createSharedImportIssue(entry, index, error));
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
    input: unknown,
    options: { restoreSource?: CodexAccountsRestoreResult["source"] } = {}
  ): Promise<CodexAccountRecord[]> {
    const entries = toSharedEntries(input).map(requireSharedAccountEntry);
    const imported: CodexAccountRecord[] = [];

    for (const entry of entries) {
      const restoredTokens = restoreSharedTokens(entry);
      imported.push(
        await this.upsertFromTokensInternal(restoredTokens, false, {
          restoreSource: options.restoreSource,
          addedVia: "json",
          sharedEntry: entry
        })
      );
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
    // 按账号串行化，避免切号与后台续期并发刷新同一账号 token
    return this.accountMutex.runExclusive(accountId, () => this.switchAccountLocked(accountId));
  }

  private async switchAccountLocked(accountId: string): Promise<CodexAccountRecord> {
    if (!(await this.getAccount(accountId))) {
      throw createError.accountNotFound(accountId);
    }

    await this.getFreshTokens(accountId);
    return withCredentialLock(this.credentialLockDirectory, `write:${accountId}`, () =>
      this.withAuthLock((assertHeld) =>
        this.changeIndex(async (index) => {
          const nextAccount = switchActiveAccount(index, accountId);
          if (!nextAccount) {
            throw createError.accountNotFound(accountId);
          }
          const tokens = await this.secretStore.getTokens(accountId);
          if (!tokens?.accessToken) {
            throw new AccountError(`Tokens missing for account ${nextAccount.email}`, {
              code: ErrorCode.AUTH_TOKEN_MISSING
            });
          }
          const effectiveTokens = { ...tokens, accountId: tokens.accountId ?? nextAccount.accountId };
          assertHeld();
          await writeAuthFile(effectiveTokens);
          await mirrorAideckCodexAccount(nextAccount, effectiveTokens);
          await mirrorAideckCurrentAccount(accountId);
          return nextAccount;
        })
      )
    );
  }

  private async withAuthLock<T>(operation: (assertHeld: () => void) => Promise<T>): Promise<T> {
    // When these locks are nested, acquire account writes, auth.json, then the repository index.
    const directory = await resolveAuthDirectory(path.resolve(path.dirname(getAuthJsonPath())));
    const lockDirectory = path.join(os.homedir(), ".codex-accounts-manager", "auth-locks");
    return withCredentialLock(lockDirectory, directory, operation);
  }

  private async updateActiveAuth(
    accountId: string,
    tokens: CodexTokens,
    previous?: CodexTokens,
    source: "renewal" | "mirror" = "renewal"
  ): Promise<boolean> {
    if (sameTokenSnapshot(previous, tokens)) {
      return false;
    }

    return this.withAuthLock(async (assertHeld) => {
      const auth = await readAuthFile();
      const workspaceId = previous?.accountId ?? tokens.accountId;
      const current = auth && tokensFromAuth(auth, workspaceId);
      if (!current) {
        return false;
      }
      if (
        !sameTokenSnapshot(current, previous) &&
        (source === "mirror" ||
          current.accountId !== workspaceId ||
          accountIdFromAuth(auth, (await this.loadIndex()).accounts) !== accountId ||
          (previous && !isNewerAccessToken(previous.accessToken, current.accessToken)))
      ) {
        return false;
      }
      if (sameTokenSnapshot(current, tokens)) {
        return true;
      }
      assertHeld();
      await writeAuthFile(tokens);
      await mirrorAideckCurrentAccount(accountId);
      return true;
    });
  }

  private async hasSavedAccount(accountId: string): Promise<boolean> {
    return (await this.loadIndex()).accounts.some((account) => account.id === accountId);
  }

  /**
   * 移除账号
   */
  async removeAccount(accountId: string): Promise<void> {
    if (!(await this.hasSavedAccount(accountId))) {
      return;
    }

    await this.secretStore.deleteTokens(accountId, async () => {
      this.invalidateTokenCache();
      clearQuotaCacheForAccount(accountId);
      await this.changeIndex(async (index) => {
        if (removeAccountFromIndex(index, accountId)) {
          await removeAideckCodexAccount(accountId);
        }
      });
    });
  }

  /**
   * 设置状态栏可见性
   *
   * @param accountId - 账号 ID
   * @param visible - 是否可见
   * @returns 更新后的账号记录
   */
  async setStatusBarVisibility(accountId: string, visible: boolean): Promise<CodexAccountRecord> {
    return this.changeIndex((index) => {
      const account = setStatusBarVisibilityOnIndex(index, accountId, visible, Date.now());
      if (!account) {
        throw createError.accountNotFound(accountId);
      }
      return account;
    });
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
    updatedPlanType?: string,
    updatedSubscriptionActiveUntil?: string,
    expectedTokens?: CodexTokens,
    expectedWorkspace?: AccountWorkspace,
    observedAt?: number,
    onSuperseded?: () => void
  ): Promise<CodexAccountRecord> {
    const existing = (await this.loadIndex()).accounts.find((item) => item.id === accountId);
    if (!existing) {
      throw createError.accountNotFound(accountId);
    }
    const verifyWorkspace = (account: CodexAccountRecord) => {
      if (expectedWorkspace && !sameAccountWorkspace(account, expectedWorkspace)) {
        throw new AccountError("Codex workspace changed during quota refresh", { code: ErrorCode.ACCOUNT_INVALID_DATA });
      }
    };
    verifyWorkspace(existing);

    const currentTokens = await this.secretStore.getTokens(accountId);
    if (expectedTokens && !sameTokenSnapshot(currentTokens, expectedTokens)) {
      this.invalidateTokenCache();
      onSuperseded?.();
      return existing;
    }
    const now = Date.now();
    const storedTokens = updatedTokens ?? currentTokens;
    const effectiveTokens = storedTokens && {
      ...storedTokens,
      accountId: existing.accountId ?? storedTokens.accountId
    };
    const commitQuota = () =>
      this.changeIndex(async (index) => {
        const account = index.accounts.find((item) => item.id === accountId);
        if (!account) {
          throw createError.accountNotFound(accountId);
        }
        verifyWorkspace(account);
        applyQuotaUpdate({ account, quotaSummary, quotaError, updatedPlanType, updatedSubscriptionActiveUntil, now });
        if (!quotaError && quotaSummary && account.quotaSummary && observedAt !== undefined) {
          recordQuotaHistory(account, account.quotaSummary, observedAt, effectiveTokens);
        }
        if (effectiveTokens) {
          syncLoginAtFromTokens(account, effectiveTokens);
          await mirrorAideckCodexAccount(account, effectiveTokens);
        }
        return account;
      });

    let account = existing;
    if (effectiveTokens) {
      const saved = await this.secretStore.setTokens(accountId, effectiveTokens, {
        expectedTokens: currentTokens,
        beforeSave: async () => {
          const latest = await this.getAccount(accountId);
          if (latest) {
            verifyWorkspace(latest);
          }
          return Boolean(latest);
        },
        afterSave: async () => {
          this.invalidateTokenCache();
          await this.updateActiveAuth(accountId, effectiveTokens, currentTokens);
          account = await commitQuota();
        }
      });
      if (!saved) {
        this.invalidateTokenCache();
        if (expectedWorkspace && !(await this.hasSavedAccount(accountId))) {
          throw createError.accountNotFound(accountId);
        }
        onSuperseded?.();
        return account;
      }
    } else {
      account = await commitQuota();
    }

    const effectivePlanType = account.planType;
    if (storedTokens && shouldAttemptRemoteProfileRepair(account, effectivePlanType)) {
      // 后台异步拉取远程档案，不阻塞配额刷新
      void fetchRemoteAccountProfile(storedTokens, {
        preferredOrganizationId: account.organizationId,
        preferredAccountName: account.accountName,
        preferredAccountStructure: account.accountStructure
      })
        .then(async (remoteProfile) => {
          if (!remoteProfile) {
            return;
          }
          await withCredentialLock(this.credentialLockDirectory, `write:${accountId}`, async (assertHeld) => {
            if (!sameTokenSnapshot(await this.secretStore.getTokens(accountId), storedTokens)) {
              return;
            }
            const freshIndex = await this.readIndexForEdit();
            const freshAccount = freshIndex.accounts.find((item) => item.id === account.id);
            if (freshAccount && sameAccountWorkspace(freshAccount, account)) {
              applyRemoteProfileFromTokens({
                account: freshAccount,
                tokens: storedTokens,
                remoteProfile,
                planType: freshAccount.planType ?? effectivePlanType,
                preservePlanType: true
              });
              assertHeld();
              await this.writeIndex(freshIndex);
            }
          });
        })
        .catch(() => undefined);
    }

    return account;
  }

  /**
   * 同步激活账号状态 (从 auth.json)
   */
  async syncActiveAccountFromAuthFile(): Promise<void> {
    const auth = await readAuthFile();
    const derivedId = accountIdFromAuth(auth, (await this.loadIndex()).accounts);
    let hydratedAccountId: string | undefined;
    if (auth?.tokens?.id_token && auth.tokens.access_token && derivedId) {
      const index = await this.readIndexForEdit();
      const account = index.accounts.find((item) => item.id === derivedId);
      if (account) {
        const nextTokens: CodexTokens = {
          idToken: auth.tokens.id_token,
          accessToken: auth.tokens.access_token,
          refreshToken: auth.tokens.refresh_token,
          accountId:
            auth.tokens.account_id ??
            extractClaims(auth.tokens.id_token, auth.tokens.access_token).accountId ??
            account.accountId
        };
        const storedTokens = await this.secretStore.getTokens(derivedId);
        const hasNewerStoredTokens =
          storedTokens &&
          (storedTokens.accountId ?? account.accountId) === nextTokens.accountId &&
          isNewerAccessToken(storedTokens.accessToken, nextTokens.accessToken);
        if (!hasNewerStoredTokens && shouldSyncTokensFromAuthFile(storedTokens, nextTokens)) {
          const saved = await this.secretStore.setTokens(derivedId, nextTokens, {
            expectedTokens: storedTokens,
            beforeSave: async () =>
              (await this.hasSavedAccount(derivedId)) && isDeepStrictEqual(auth, await readAuthFile()),
            afterSave: async () => {
              this.invalidateTokenCache();
              clearQuotaCacheForAccount(derivedId);
              if (account.accountId && nextTokens.accountId && nextTokens.accountId !== account.accountId) {
                clearDerivedWorkspaceData(account);
              }
              account.accountId = nextTokens.accountId ?? account.accountId;
              if (getQuotaIssueKind(account.quotaError) === "auth") {
                account.quotaError = undefined;
                account.dismissedHealthIssueKey = undefined;
              }
              account.updatedAt = Date.now();
              await this.writeIndex(index, derivedId);
            }
          });
          if (saved) {
            hydratedAccountId = derivedId;
          }
        }
      }
    }

    await this.withAuthLock(() =>
      this.changeIndex(async (index) => {
        const activeId = accountIdFromAuth(await readAuthFile(), index.accounts);
        const previousActiveId = index.currentAccountId;
        syncActiveAccountState(index, activeId);
        if (index.currentAccountId && index.currentAccountId !== previousActiveId) {
          reconcileStatusBarSelections(index, index.currentAccountId, previousActiveId);
        }
        if (
          index.currentAccountId &&
          (index.currentAccountId !== previousActiveId || index.currentAccountId === hydratedAccountId)
        ) {
          await mirrorAideckCurrentAccount(index.currentAccountId);
        }
      })
    );
  }

  /**
   * 确认工作区后刷新订阅明细，查询未确认时保留现有值并退避。
   */
  async refreshSubscriptionState(accountId: string, force = false): Promise<void> {
    const inflight = this.subscriptionRefreshes.get(accountId);
    if (inflight) {
      if (!force || inflight.force) {
        return inflight.task;
      }
      await inflight.task.catch(() => undefined);
      return this.refreshSubscriptionState(accountId, true);
    }

    const refreshTask = this.refreshSubscriptionStateInternal(accountId, force);
    this.subscriptionRefreshes.set(accountId, { force, task: refreshTask });
    try {
      await refreshTask;
    } finally {
      if (this.subscriptionRefreshes.get(accountId)?.task === refreshTask) {
        this.subscriptionRefreshes.delete(accountId);
      }
    }
  }

  private async refreshSubscriptionStateInternal(accountId: string, force = false): Promise<void> {
    const account = await this.getAccount(accountId);
    if (!account || !shouldAttemptSubscriptionRefresh(account, force)) {
      return;
    }

    const tokens = await this.getTokens(accountId, { bypassCache: true });
    const startedAt = Date.now();
    let snapshot: SubscriptionStatusSnapshot | undefined;
    let fetchError: string | undefined;
    if (tokens?.accessToken) {
      try {
        snapshot = await fetchSubscriptionStatus(
          tokens.accessToken,
          account.accountId ?? tokens.accountId,
          account.organizationId,
          account.accountName,
          account.accountStructure
        );
      } catch (error) {
        fetchError = error instanceof Error ? error.message : String(error);
      }
    } else {
      fetchError = "No access token available";
    }

    await this.secretStore.withTokenWrite(accountId, async (currentTokens) => {
      if (!sameTokenSnapshot(currentTokens, tokens)) {
        return;
      }
      await this.changeIndex((index) => {
        const latest = index.accounts.find((item) => item.id === accountId);
        if (
          !latest || !sameAccountWorkspace(latest, account) ||
          latest.accountName !== account.accountName || latest.accountStructure !== account.accountStructure ||
          (latest.subscriptionQueryLastAttemptAt ?? 0) > startedAt ||
          ((latest.lastQuotaAt ?? 0) > startedAt && latest.subscriptionExpirySource === "confirmed-free")
        ) {
          return;
        }

        const repaired = Boolean(snapshot?.accountId && snapshot.accountId !== latest.accountId);
        if (
          !snapshot || snapshot.source === "unconfirmed" ||
          (snapshot.source === "entitlement" &&
            (latest.subscriptionExpirySource === "subscription" || latest.subscriptionExpirySource === "confirmed-free") &&
            !repaired)
        ) {
          markSubscriptionRetryPending(latest, fetchError ?? "Subscription expiry could not be confirmed");
        } else {
          const plan = normalizePlanType(snapshot.planType);
          if (repaired && latest.accountId) {
            clearDerivedWorkspaceData(latest);
            clearQuotaCacheForAccount(accountId);
          }
          if (plan && (latest.planType === account.planType || repaired)) {
            latest.planType = plan;
          }
          latest.accountId = snapshot.accountId ?? latest.accountId;
          latest.subscriptionActiveUntil = snapshot.subscriptionActiveUntil;
          latest.subscriptionExpirySource = snapshot.source;
          latest.updatedAt = Date.now();
          clearSubscriptionRetryPending(latest);
        }
        latest.subscriptionQueryLastAttemptAt = startedAt;
      });
    });
  }

  async redeemResetCredit(
    confirmedAccount: CodexAccountRecord,
    requestWorkspace: Pick<CodexResetCreditRedemption, "accountId" | "organizationId" | "userId">,
    submit: (requestId: string, creditId?: string) => Promise<ResetCreditRedemptionOutcome>,
    creditId?: string
  ): Promise<ResetCreditRedemptionOutcome> {
    const accountId = confirmedAccount.id;
    return withCredentialLock(this.credentialLockDirectory, `reset-credit:${accountId}`, async (assertHeld) => {
      const { requestId, creditId: selectedCreditId } = await this.changeIndex((index) => {
        const account = index.accounts.find((item) => item.id === accountId);
        if (!account || !sameAccountWorkspace(account, confirmedAccount)) {
          throw new Error("Codex workspace changed. Reopen the account before redeeming a reset credit.");
        }
        const latest = account.resetCreditRedemption;
        const confirmed = confirmedAccount.resetCreditRedemption;
        if (latest?.requestId !== confirmed?.requestId || latest?.pending !== confirmed?.pending) {
          throw new Error("The reset request changed in another window. Reopen the account to see its current state.");
        }
        if (latest?.pending) {
          if (!sameAccountWorkspace(requestWorkspace, latest)) {
            throw new Error("The pending reset request belongs to a different Codex workspace.");
          }
          if (creditId !== undefined && latest.creditId !== creditId) {
            throw new Error("Confirm the previous reset before using another credit.");
          }
          if (!account.resetCreditLocalHistory?.some((entry) => entry.requestId === latest.requestId)) {
            account.resetCreditLocalHistory = [...(account.resetCreditLocalHistory ?? []), {
              requestId: latest.requestId, outcome: "pending" as const, ...requestWorkspace
            }].slice(-100);
          }
          return latest;
        }
        const inventory = account.resetCreditInventory?.snapshot;
        if (creditId !== undefined && !(inventory && inventory.availableCount > 0 &&
          inventory.credits.some((credit) => credit.id === creditId && isAvailableResetCredit(credit)))) {
          throw new Error("This reset credit is no longer available. Reload the available credits.");
        }
        if (creditId === undefined && (account.quotaSummary?.resetCreditsAvailable ?? inventory?.availableCount ?? 0) <= 0) {
          throw new Error("No reset credits available");
        }

        const requestId = randomUUID();
        account.resetCreditRedemption = {
          requestId,
          pending: true,
          creditId,
          ...requestWorkspace
        };
        account.resetCreditLocalHistory = [...(account.resetCreditLocalHistory ?? []), {
          requestId, occurredAt: Date.now(), outcome: "pending" as const, ...requestWorkspace
        }].slice(-100);
        return account.resetCreditRedemption;
      });

      // The request is durable before the POST. Transport errors leave it pending.
      assertHeld();
      const outcome = await submit(requestId, selectedCreditId);
      assertHeld();
      await this.changeIndex((index) => {
        const account = index.accounts.find((item) => item.id === accountId);
        const attempt = account?.resetCreditRedemption;
        if (attempt?.requestId === requestId && attempt.pending) {
          attempt.pending = false;
          const record = account?.resetCreditLocalHistory?.find((item) => item.requestId === requestId);
          if (record) {
            record.outcome = outcome;
          }
          if (account?.resetCreditInventory && sameAccountWorkspace(account, confirmedAccount)) {
            account.resetCreditInventory.refreshAt = 0;
            if (selectedCreditId !== undefined && (outcome === "reset" || outcome === "already_redeemed")) {
              const credit = account.resetCreditInventory.snapshot?.credits.find((item) => item.id === selectedCreditId);
              if (credit) {
                credit.status = "redeemed";
              }
            }
          }
        }
      });
      return outcome;
    });
  }

  async refreshResetCreditInventory(
    requested: CodexAccountRecord,
    fetchSnapshot: (account: CodexAccountRecord) => Promise<CodexResetCreditsSnapshot>,
    force = false
  ): Promise<CodexResetCreditsSnapshot | undefined> {
    if (!force && (requested.resetCreditInventory?.refreshAt ?? 0) > Date.now()) {
      return undefined;
    }
    const { id } = requested;
    const lane = force ? "manual" : "background";
    return withCredentialLock(this.credentialLockDirectory, `reset-credit:${id}`, async (assertHeld) => {
      const account = await this.getAccount(id);
      if (!account || !sameAccountWorkspace(account, requested)) {
        throw new Error("Codex workspace changed during reset credit inventory refresh");
      }
      const cached = account.resetCreditInventory;
      if ((cached?.refreshAt ?? 0) > Date.now()) {
        if (!force) {
          return undefined;
        }
        if (cached?.snapshot && cached.receivedAt !== requested.resetCreditInventory?.receivedAt) {
          return cached.snapshot;
        }
      }

      return withCredentialLock(this.credentialLockDirectory, `reset-credit-inventory:${lane}`, async () => {
        let snapshot: CodexResetCreditsSnapshot;
        try {
          snapshot = await fetchSnapshot(account);
        } catch (error) {
          assertHeld();
          await this.changeIndex((index) => {
            const latest = index.accounts.find((item) => item.id === id);
            if (latest && sameAccountWorkspace(latest, account)) {
              latest.resetCreditInventory = { ...latest.resetCreditInventory, refreshAt: Date.now() + 60_000 };
            }
          });
          throw error;
        }

        assertHeld();
        await this.changeIndex((index) => {
          const latest = index.accounts.find((item) => item.id === id);
          if (!latest || !sameAccountWorkspace(latest, account)) {
            throw new Error("Codex workspace changed while loading reset credit inventory");
          }
          const now = Date.now();
          // Stagger automatic checks across accounts and recheck near a known expiry.
          const expiry = (snapshot.nextExpiresAt ?? 0) * 1000;
          const refreshAt = Math.min(now + (5 + Math.random() * 2) * 3_600_000, expiry > now ? expiry : Infinity);
          const quota = latest.quotaSummary;
          latest.resetCreditInventory = {
            snapshot,
            receivedAt: now,
            refreshAt,
            usageCount: latest.resetCreditInventory ? latest.resetCreditInventory.usageCount : quota?.resetCreditsAvailable
          };
          if (quota) {
            quota.resetCreditsAvailable = snapshot.availableCount;
            quota.resetCreditsNextExpiresAt = snapshot.nextExpiresAt;
          }
          latest.updatedAt = now;
        });
        return snapshot;
      });
    });
  }

  /**
   * 更新重置次数快照（由后台 fetchResetCredits 拉取后调用）。
   */
  async updateResetCreditsSnapshot(
    accountId: string,
    availableCount: number,
    nextExpiresAt?: number
  ): Promise<void> {
    await this.writeResetCredits(accountId, nextExpiresAt, availableCount);
  }

  /**
   * 兼容旧调用：仅更新最近到期时间。
   */
  async updateResetCreditsExpiry(accountId: string, nextExpiresAt: number): Promise<void> {
    await this.writeResetCredits(accountId, nextExpiresAt);
  }

  private async writeResetCredits(accountId: string, nextExpiresAt?: number, availableCount?: number): Promise<void> {
    await this.changeIndex((index) => {
      const account = index.accounts.find((item) => item.id === accountId);
      const quota = account?.quotaSummary;
      if (!account || !quota) {
        return;
      }

      const previousNextExpiresAt = quota.resetCreditsNextExpiresAt;
      const effectiveAvailableCount = availableCount ?? quota.resetCreditsAvailable ?? 0;
      const effectiveNextExpiresAt = nextExpiresAt ?? (effectiveAvailableCount > 0 ? previousNextExpiresAt : undefined);
      if (effectiveAvailableCount > 0 || previousNextExpiresAt != null || nextExpiresAt != null) {
        console.info("[codexAccounts] reset credits snapshot update", {
          accountId,
          previousAvailable: quota.resetCreditsAvailable ?? null,
          previousNextExpiresAt: previousNextExpiresAt ?? null,
          incomingAvailable: effectiveAvailableCount,
          incomingNextExpiresAt: nextExpiresAt ?? null,
          storedNextExpiresAt: effectiveNextExpiresAt ?? null,
          preservedResetCreditsExpiry: nextExpiresAt == null && effectiveNextExpiresAt != null
        });
      }
      quota.resetCreditsAvailable = effectiveAvailableCount;
      quota.resetCreditsNextExpiresAt = effectiveNextExpiresAt;
      account.updatedAt = Date.now();
    });
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

  private async readIndexForEdit(): Promise<CodexAccountsIndex> {
    const index = await this.loadIndex();
    this.indexBaselines.set(index, structuredClone(index));
    return index;
  }

  private async loadIndex(lockHeld = false): Promise<CodexAccountsIndex> {
    try {
      const index = await readIndexSnapshot(this.indexPath);
      if (this.state.indexHealth.status === "corrupted_unrecoverable") {
        this.state.indexHealth = { status: "healthy", availableBackups: 0 };
      }
      return index;
    } catch (cause) {
      if (isFileNotFoundError(cause)) {
        if (this.state.indexHealth.status === "corrupted_unrecoverable") {
          this.state.indexHealth = { status: "healthy", availableBackups: 0 };
        }
        return createEmptyIndex();
      }
      if (!lockHeld) {
        return this.withIndexLock(() => this.loadIndex(true));
      }
      const restored = await this.tryRestoreFromBackups("backup", cause);
      return (
        restored ??
        markUnrecoverableIndex({
          state: this.state,
          indexPath: this.indexPath,
          backupCount: INDEX_BACKUP_COUNT,
          cause
        })
      );
    }
  }

  private async readIndexForRecovery(): Promise<CodexAccountsIndex> {
    const index = await readIndexForRecovery(() => this.loadIndex());
    this.indexBaselines.set(index, structuredClone(index));
    return index;
  }

  private withIndexLock<T>(operation: (assertHeld: () => void) => Promise<T>): Promise<T> {
    return withCredentialLock(this.credentialLockDirectory, "accounts-index", operation);
  }

  private async changeIndex<T>(operation: (index: CodexAccountsIndex) => T | Promise<T>): Promise<T> {
    return this.withIndexLock(async (assertHeld) => {
      const index = await this.loadIndex(true);
      const before = structuredClone(index);
      const result = await operation(index);
      if (!isDeepStrictEqual(before, index)) {
        assertHeld();
        await persistIndexWithBackups({
          state: this.state,
          indexPath: this.indexPath,
          index,
          tempSuffix: INDEX_TEMP_SUFFIX,
          backupCount: INDEX_BACKUP_COUNT
        });
      }
      return result;
    });
  }

  private async mirrorSavedAccount(index: CodexAccountsIndex, accountId: string): Promise<void> {
    const account = index.accounts.find((item) => item.id === accountId);
    if (account) {
      await mirrorAideckCodexAccount(account, await this.secretStore.getTokens(accountId));
    }
  }

  private async writeIndex(index: CodexAccountsIndex, mirrorAccountId?: string): Promise<void> {
    const before = this.indexBaselines.get(index);
    if (!before) {
      throw new Error("Cannot save an accounts index without its original snapshot");
    }
    const changed = !isDeepStrictEqual(before, index);
    if (!changed && !mirrorAccountId) {
      return;
    }
    await this.changeIndex(async (latest) => {
      if (changed) {
        applyIndexChanges(latest, before, index);
      }
      if (mirrorAccountId) {
        await this.mirrorSavedAccount(latest, mirrorAccountId);
      }
    });
    if (changed) {
      this.indexBaselines.set(index, structuredClone(index));
    }
  }

  private async persistRecoveredIndex(
    index: CodexAccountsIndex,
    source: CodexAccountsRestoreResult["source"],
    mirrorAccountId: string
  ): Promise<void> {
    await this.withIndexLock(async (assertHeld) => {
      const latest = await readIndexForRecovery(() => this.loadIndex(true));
      const before = this.indexBaselines.get(index);
      if (!before) {
        throw new Error("Cannot restore an accounts index without its original snapshot");
      }
      applyIndexChanges(latest, before, index);
      assertHeld();
      await persistRecoveredIndex({
        state: this.state,
        index: latest,
        source,
        indexPath: this.indexPath,
        tempSuffix: INDEX_TEMP_SUFFIX,
        backupCount: INDEX_BACKUP_COUNT
      });
      await this.mirrorSavedAccount(latest, mirrorAccountId);
    });
  }

  private async tryRestoreFromBackups(
    source: CodexAccountsRestoreResult["source"],
    originalError?: unknown
  ): Promise<CodexAccountsIndex | undefined> {
    return tryRestoreFromBackups({
      state: this.state,
      indexPath: this.indexPath,
      backupCount: INDEX_BACKUP_COUNT,
      tempSuffix: INDEX_TEMP_SUFFIX,
      source,
      originalError
    });
  }
}

async function resolveAuthDirectory(directory: string): Promise<string> {
  try {
    return await fs.realpath(directory);
  } catch (error) {
    const parent = path.dirname(directory);
    if (!isFileNotFoundError(error) || parent === directory) {
      throw error;
    }
    // A first-time switch and a later reader must use the same key even through a symlinked parent.
    return path.join(await resolveAuthDirectory(parent), path.basename(directory));
  }
}

function tokensFromAuth(auth: CodexAuthFile, workspaceId?: string): CodexTokens | undefined {
  const tokens = auth.tokens;
  if (!tokens?.id_token || !tokens.access_token) {
    return undefined;
  }
  return {
    idToken: tokens.id_token,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accountId: tokens.account_id ?? workspaceId
  };
}

function isNewerAccessToken(candidate: string, current: string): boolean {
  function compareClaim(left: unknown, right: unknown): number | undefined {
    return typeof left === "number" && Number.isFinite(left) && typeof right === "number" && Number.isFinite(right)
      ? left - right
      : undefined;
  }

  try {
    const left = decodeJwtPayload(candidate);
    const right = decodeJwtPayload(current);
    // A later expiry alone is useful only when issue times are unavailable.
    return (compareClaim(left["iat"], right["iat"]) ?? compareClaim(left["exp"], right["exp"]) ?? 0) > 0;
  } catch {
    return false;
  }
}

function accountIdFromAuth(auth: CodexAuthFile | undefined, accounts: readonly CodexAccountRecord[]): string | undefined {
  const claims = auth?.tokens && extractClaims(auth.tokens.id_token, auth.tokens.access_token);
  return claims?.email ? resolveAccountStorageId({ ...claims, email: claims.email }, accounts) : undefined;
}

function assertReauthorizationIdentity(
  saved: CodexAccountRecord,
  previous: CodexTokens | undefined,
  claims: ReturnType<typeof extractClaims>,
  email: string,
  tokenAccountId: string | undefined
): void {
  const original = safeExtractTokenClaims(previous);
  const userId = original?.userId ?? saved.userId;
  const accountId = original?.accountId ?? saved.accountId;
  const organizationId = original?.organizationId ?? saved.organizationId;
  const conflict = (expected?: string, actual?: string) => Boolean(expected && actual && expected !== actual);
  const sameEmail = saved.email === email;
  const sameIdentity = userId && userId === claims.userId &&
    accountId && accountId === claims.accountId && organizationId === claims.organizationId;
  if (
    (userId && userId !== claims.userId) || conflict(accountId, claims.accountId) ||
    organizationId !== claims.organizationId || conflict(claims.accountId ?? accountId, tokenAccountId) ||
    conflict(saved.organizationId, claims.organizationId) ||
    (!claims.accountId && accountId && tokenAccountId !== accountId) ||
    (!sameEmail && !sameIdentity)
  ) {
    throw new AccountError("Authorized credentials belong to a different Codex user or workspace", {
      code: ErrorCode.ACCOUNT_INVALID_DATA
    });
  }
}

function reauthorizationWorkspaceMayOverlap(left: CodexAccountRecord, right: CodexAccountRecord): boolean {
  if (left.accountId && right.accountId && left.accountId !== right.accountId) {
    return false;
  }
  if (left.organizationId && right.organizationId) {
    return left.organizationId === right.organizationId;
  }
  const leftKind = workspaceKind(left.accountStructure, left.planType);
  const rightKind = workspaceKind(right.accountStructure, right.planType);
  return !leftKind || !rightKind || leftKind === rightKind;
}

function shouldKeepReauthorizedTokens(
  current: CodexTokens | undefined,
  baseline: CodexTokens | undefined,
  incoming: CodexTokens
): boolean {
  if (!current || sameTokenSnapshot(current, incoming)) {
    return false;
  }
  // Preserve a concurrent commit when timestamps cannot establish the incoming credentials as newer.
  return (
    isNewerAccessToken(current.accessToken, incoming.accessToken) ||
    (!sameTokenSnapshot(current, baseline) && !isNewerAccessToken(incoming.accessToken, current.accessToken))
  );
}

function shouldSyncTokensFromAuthFile(
  current: CodexTokens | undefined,
  next: CodexTokens
): boolean {
  return toComparableTokenSnapshot(current) !== toComparableTokenSnapshot(next);
}

function toComparableTokenSnapshot(tokens: CodexTokens | undefined): string {
  if (!tokens) {
    return "";
  }

  return JSON.stringify({
    idToken: tokens.idToken ?? "",
    accessToken: tokens.accessToken ?? "",
    refreshToken: tokens.refreshToken ?? "",
    accountId: tokens.accountId ?? ""
  });
}

function mergeExternalTokens(
  current: CodexTokens | undefined,
  external: AideckMirrorTokenSnapshot | undefined,
  account?: CodexAccountRecord
): CodexTokens | undefined {
  if (!external) {
    return current;
  }

  if (!canAdoptExternalMirrorTokens(current, external, account)) {
    return current;
  }

  if (
    current?.accessToken &&
    external.accessToken &&
    current.accessToken !== external.accessToken &&
    (isNewerAccessToken(current.accessToken, external.accessToken) ||
      (!isTokenExpired(current.accessToken, 0) && isTokenExpired(external.accessToken, 0)))
  ) {
    return current;
  }

  if (
    current?.refreshToken &&
    external.refreshToken &&
    external.refreshToken !== current.refreshToken &&
    (!external.accessToken || !isNewerAccessToken(external.accessToken, current.accessToken))
  ) {
    return current;
  }

  const merged: CodexTokens = {
    idToken: external.idToken ?? current?.idToken ?? "",
    accessToken: external.accessToken ?? current?.accessToken ?? "",
    refreshToken: external.refreshToken ?? current?.refreshToken,
    accountId: external.accountId ?? current?.accountId
  };

  if (!merged.idToken || !merged.accessToken) {
    return current;
  }

  return merged;
}

function canAdoptExternalMirrorTokens(
  current: CodexTokens | undefined,
  external: AideckMirrorTokenSnapshot,
  account?: CodexAccountRecord
): boolean {
  const externalClaims = safeExtractTokenClaims(external);
  if (!isMirrorSnapshotInternallyConsistent(external, externalClaims)) {
    return false;
  }

  if (
    hasRequiredIdentityMismatch(account?.email ? normalizeEmailIdentity(account.email) : undefined, externalClaims?.email) ||
    hasRequiredIdentityMismatch(account?.userId, externalClaims?.userId) ||
    hasRequiredIdentityMismatch(account?.accountId, external.accountId ?? externalClaims?.accountId) ||
    hasRequiredIdentityMismatch(account?.organizationId, externalClaims?.organizationId)
  ) {
    return false;
  }

  const expected = buildExpectedMirrorIdentity(account, current);
  const candidate = buildExternalMirrorIdentity(external, externalClaims);
  if (
    hasRequiredIdentityMismatch(expected.email, candidate.email) ||
    hasRequiredIdentityMismatch(expected.userId, candidate.userId) ||
    hasRequiredIdentityMismatch(expected.accountId, candidate.accountId) ||
    hasRequiredIdentityMismatch(expected.organizationId, candidate.organizationId)
  ) {
    return false;
  }

  return Boolean(candidate.accountId || candidate.organizationId || candidate.email || candidate.userId);
}

function buildExpectedMirrorIdentity(
  account: CodexAccountRecord | undefined,
  current: CodexTokens | undefined
): {
  email?: string;
  userId?: string;
  accountId?: string;
  organizationId?: string;
} {
  const claims = safeExtractTokenClaims(current);
  return {
    email: normalizeEmailIdentity(account?.email ?? claims?.email),
    userId: account?.userId ?? claims?.userId,
    accountId: account?.accountId ?? current?.accountId ?? claims?.accountId,
    organizationId: account?.organizationId ?? claims?.organizationId
  };
}

function buildExternalMirrorIdentity(
  external: AideckMirrorTokenSnapshot,
  claims:
    | {
        email?: string;
        userId?: string;
        accountId?: string;
        organizationId?: string;
      }
    | undefined = safeExtractTokenClaims(external)
): {
  email?: string;
  userId?: string;
  accountId?: string;
  organizationId?: string;
} {
  return {
    email: normalizeEmailIdentity(external.email ?? claims?.email),
    userId: external.userId ?? claims?.userId,
    accountId: external.accountId ?? claims?.accountId,
    organizationId: external.organizationId ?? claims?.organizationId
  };
}

function safeExtractTokenClaims(tokens: Partial<CodexTokens> | undefined):
  | {
      email?: string;
      userId?: string;
      accountId?: string;
      organizationId?: string;
    }
  | undefined {
  if (!tokens?.idToken) {
    return undefined;
  }

  try {
    const claims = extractClaims(tokens.idToken, tokens.accessToken);
    return {
      email: normalizeEmailIdentity(claims.email),
      userId: claims.userId,
      accountId: claims.accountId,
      organizationId: claims.organizationId
    };
  } catch {
    return undefined;
  }
}

function normalizeEmailIdentity(email: string | undefined): string | undefined {
  const trimmed = email?.trim().toLowerCase();
  return trimmed || undefined;
}

function isMirrorSnapshotInternallyConsistent(
  external: AideckMirrorTokenSnapshot,
  claims:
    | {
        email?: string;
        userId?: string;
        accountId?: string;
        organizationId?: string;
      }
    | undefined
): boolean {
  if (!external.idToken) {
    return true;
  }

  if (!claims) {
    return false;
  }

  return !(
    hasRequiredIdentityMismatch(normalizeEmailIdentity(external.email), claims.email) ||
    hasRequiredIdentityMismatch(external.userId, claims.userId) ||
    hasRequiredIdentityMismatch(external.accountId, claims.accountId) ||
    hasRequiredIdentityMismatch(external.organizationId, claims.organizationId)
  );
}

function hasRequiredIdentityMismatch(expected: string | undefined, candidate: string | undefined): boolean {
  return Boolean(expected && expected !== candidate);
}

/**
 * 协调状态栏选择
 */
