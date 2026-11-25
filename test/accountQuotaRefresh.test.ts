import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import type { CodexAccountRecord, CodexTokens } from "../src/core/types";
import type { AccountsRepository } from "../src/storage";

const { refreshQuotaMock, fetchResetCreditsMock, clearTokenAutomationErrorMock } = vi.hoisted(() => ({
  refreshQuotaMock: vi.fn(),
  fetchResetCreditsMock: vi.fn(),
  clearTokenAutomationErrorMock: vi.fn()
}));

const { handleCodexAppRestartPreferenceMock, autoReloadWindowForAccountMock } = vi.hoisted(() => ({
  handleCodexAppRestartPreferenceMock: vi.fn(),
  autoReloadWindowForAccountMock: vi.fn()
}));

vi.mock("../src/services", () => ({
  refreshQuota: refreshQuotaMock,
  fetchResetCredits: fetchResetCreditsMock
}));

vi.mock("../src/presentation/workbench/tokenAutomationState", () => ({
  clearTokenAutomationError: clearTokenAutomationErrorMock
}));

vi.mock("../src/application/accounts/switchEffects", () => ({
  handleCodexAppRestartPreference: handleCodexAppRestartPreferenceMock,
  autoReloadWindowForAccount: autoReloadWindowForAccountMock
}));

import { maybeAutoSwitchForActiveQuota, maybeWarnForAccount, refreshImportedAccountQuota, refreshSingleQuota } from "../src/application/accounts/quota";
import { AccountsCommandService } from "../src/application/accounts/commandService";
import { setCurrentWindowRuntimeAccountId } from "../src/presentation/workbench/windowRuntimeAccount";
import { getCommandCopy } from "../src/utils";

type QuotaRefreshRepo = Pick<
  AccountsRepository,
  "getAccount" | "getFreshTokens" | "updateQuota" | "refreshSubscriptionState" | "updateResetCreditsSnapshot"
> & Partial<Pick<AccountsRepository, "refreshResetCreditInventory">>;

describe("refreshSingleQuota token automation state", () => {
  const account: CodexAccountRecord = {
    id: "account-1",
    email: "dev@example.com",
    isActive: true,
    createdAt: 1,
    updatedAt: 1
  };

  const tokens: CodexTokens = {
    idToken: "id-token",
    accessToken: "access-token",
    refreshToken: "refresh-token"
  };

  beforeEach(() => {
    refreshQuotaMock.mockReset();
    fetchResetCreditsMock.mockReset();
    clearTokenAutomationErrorMock.mockReset();
    handleCodexAppRestartPreferenceMock.mockReset();
    autoReloadWindowForAccountMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setCurrentWindowRuntimeAccountId(undefined);
  });

  it("clears automation auth error after a successful manual refresh", async () => {
    const repo: QuotaRefreshRepo = {
      getAccount: vi.fn(async () => account),
      getFreshTokens: vi.fn(async () => tokens),
      updateQuota: vi.fn(async () => account),
      refreshSubscriptionState: vi.fn(async () => undefined),
      updateResetCreditsSnapshot: vi.fn(async () => undefined)
    };

    refreshQuotaMock.mockResolvedValue({
      quota: undefined,
      error: undefined,
      updatedTokens: tokens
    });

    await refreshSingleQuota(repo as AccountsRepository, { refresh: vi.fn() }, account.id, {
      announce: false,
      refreshView: false,
      warnQuota: false,
      forceRefresh: true
    });

    expect(clearTokenAutomationErrorMock).toHaveBeenCalledWith(account.id);
  });

  it.each([200, 401, 429])("retries only the initial 401 and persists the result with the request's token snapshot (%i)", async (status) => {
    const refreshed = { ...tokens, accessToken: "new-access-token", refreshToken: "new-refresh-token" };
    const firstError = { statusCode: status === 429 ? 429 : 401, message: "first request failed", timestamp: 1 };
    const secondError = { statusCode: 401, message: "second request failed", timestamp: 2 };
    const freshQuota = { hourlyPercentage: 80, weeklyPercentage: 90, codeReviewPercentage: 100 };
    const repo: QuotaRefreshRepo = {
      getAccount: vi.fn(async () => account),
      getFreshTokens: vi.fn<AccountsRepository["getFreshTokens"]>().mockResolvedValueOnce(tokens).mockResolvedValueOnce(refreshed),
      updateQuota: vi.fn(async () => account),
      refreshSubscriptionState: vi.fn(async () => undefined),
      updateResetCreditsSnapshot: vi.fn(async () => undefined)
    };
    refreshQuotaMock.mockResolvedValueOnce({ error: firstError, updatedTokens: tokens });
    refreshQuotaMock.mockResolvedValueOnce(status === 200
      ? { quota: freshQuota, updatedTokens: refreshed }
      : { error: secondError, updatedTokens: refreshed });

    const result = await refreshSingleQuota(repo as AccountsRepository, { refresh: vi.fn() }, account.id, {
      announce: false, refreshView: false, warnQuota: false
    });

    expect(result).toBe(status === 200);
    expect(refreshQuotaMock.mock.calls).toEqual(status === 429
      ? [[account, tokens, false]]
      : [[account, tokens, false], [account, refreshed, true]]);
    expect(vi.mocked(repo.getFreshTokens).mock.calls).toEqual(status === 429
      ? [[account.id]]
      : [[account.id], [account.id, { force: true, expectedTokens: tokens, validateRefreshedTokens: expect.any(Function) }]]);
    expect(repo.updateQuota).toHaveBeenCalledExactlyOnceWith(
      account.id,
      status === 200 ? freshQuota : undefined,
      status === 200 ? undefined : status === 401 ? secondError : firstError,
      status === 200 ? refreshed : undefined,
      undefined,
      undefined,
      status === 429 ? tokens : refreshed,
      account,
      undefined,
      expect.any(Function)
    );
  });

  it("keeps the initial 401 if renewal fails and never writes the failed request's token", async () => {
    const firstError = { statusCode: 401, message: "not authorized", timestamp: 1 };
    const repo: QuotaRefreshRepo = {
      getAccount: vi.fn(async () => account),
      getFreshTokens: vi.fn<AccountsRepository["getFreshTokens"]>().mockResolvedValueOnce(tokens)
        .mockRejectedValueOnce(new Error("private OAuth refresh response")),
      updateQuota: vi.fn(async () => account),
      refreshSubscriptionState: vi.fn(async () => undefined),
      updateResetCreditsSnapshot: vi.fn(async () => undefined)
    };
    refreshQuotaMock.mockResolvedValueOnce({ error: firstError, updatedTokens: tokens });

    const result = await refreshImportedAccountQuota(repo as AccountsRepository, account.id);

    expect(result.error).toMatchObject({ statusCode: 401 });
    expect(result.error?.message).toContain("not authorized");
    expect(result.error?.message).not.toContain("private OAuth refresh response");
    expect(refreshQuotaMock).toHaveBeenCalledTimes(1);
    expect(repo.updateQuota).toHaveBeenCalledExactlyOnceWith(
      account.id, undefined, result.error, undefined, undefined, undefined, tokens, account, undefined, expect.any(Function)
    );
  });

  it("rejects a workspace change during renewal even when the upstream account ID stays the same", async () => {
    const original = { ...account, accountId: "shared-id", organizationId: "org-a", userId: "user-a" };
    const changed = { ...original, organizationId: "org-b" };
    const repo: QuotaRefreshRepo = {
      getAccount: vi.fn<AccountsRepository["getAccount"]>().mockResolvedValueOnce(original).mockResolvedValueOnce(original).mockResolvedValue(changed),
      getFreshTokens: vi.fn<AccountsRepository["getFreshTokens"]>().mockResolvedValueOnce(tokens)
        .mockResolvedValueOnce({ ...tokens, accessToken: "new-token" }),
      updateQuota: vi.fn(async () => changed),
      refreshSubscriptionState: vi.fn(async () => undefined),
      updateResetCreditsSnapshot: vi.fn(async () => undefined)
    };
    refreshQuotaMock.mockResolvedValueOnce({ error: { statusCode: 401, message: "unauthorized", timestamp: 1 } })
      .mockResolvedValueOnce({});

    await expect(refreshImportedAccountQuota(repo as AccountsRepository, original.id)).rejects.toThrow("workspace changed");
    expect(refreshQuotaMock).toHaveBeenCalledTimes(1);
    expect(repo.updateQuota).not.toHaveBeenCalled();
  });

  it.each(["organization_id", "chatgpt_user_id"])("rejects a changed token %s before retrying the same saved workspace", async (field) => {
    const jwt = (value: string) => {
      const payload = { "https://api.openai.com/auth": { chatgpt_account_id: "shared-id", [field]: value } };
      return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
    };
    const workspace = { ...account, accountId: "shared-id" };
    const initial = { ...tokens, idToken: jwt("member-a"), accessToken: jwt("member-a") };
    const renewed = { ...initial, accessToken: jwt("member-b") };
    const repo: QuotaRefreshRepo = {
      getAccount: vi.fn(async () => workspace),
      getFreshTokens: vi.fn<AccountsRepository["getFreshTokens"]>().mockResolvedValueOnce(initial).mockResolvedValueOnce(renewed),
      updateQuota: vi.fn(async () => workspace),
      refreshSubscriptionState: vi.fn(async () => undefined),
      updateResetCreditsSnapshot: vi.fn(async () => undefined)
    };
    refreshQuotaMock.mockResolvedValueOnce({ error: { statusCode: 401, message: "unauthorized", timestamp: 1 } })
      .mockResolvedValueOnce({});

    await expect(refreshImportedAccountQuota(repo as AccountsRepository, workspace.id)).rejects.toThrow("workspace changed");
    expect(refreshQuotaMock).toHaveBeenCalledTimes(1);
    expect(repo.updateQuota).not.toHaveBeenCalled();
  });

  it("counts a quota API failure as failed in the manual batch summary", async () => {
    const error = { code: "API_ERROR", message: "HTTP 429", timestamp: 1 };
    const repo = {
      listAccounts: vi.fn(async () => [{ ...account, isActive: false }]),
      getAccount: vi.fn(async () => account),
      getFreshTokens: vi.fn(async () => tokens),
      updateQuota: vi.fn(async () => account),
      refreshSubscriptionState: vi.fn(async () => undefined)
    };
    refreshQuotaMock.mockResolvedValue({ error });
    vi.mocked(vscode.window.showWarningMessage).mockClear();
    vi.mocked(vscode.window.showInformationMessage).mockClear();
    const command = new AccountsCommandService({} as vscode.ExtensionContext, repo as unknown as AccountsRepository, {
      refresh: vi.fn()
    });

    await command.refreshAllQuotas();

    expect(repo.updateQuota).toHaveBeenCalledWith(
      account.id,
      undefined,
      error,
      undefined,
      undefined,
      undefined,
      tokens,
      account,
      undefined,
      expect.any(Function)
    );
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(getCommandCopy().refreshAllSummary(0, 1));
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("does not count a successful response discarded by the credential guard", async () => {
    const repo = {
      getAccount: async () => account, getFreshTokens: async () => tokens,
      updateQuota: vi.fn<AccountsRepository["updateQuota"]>(async (...args) => {
        args[9]?.();
        return account;
      }),
      refreshSubscriptionState: async () => undefined
    };
    refreshQuotaMock.mockResolvedValue({ quota: { hourlyPercentage: 3, weeklyPercentage: 20 } });
    await expect(refreshSingleQuota(repo as unknown as AccountsRepository, { refresh() {} }, account.id, {
      announce: false, warnQuota: false, throwOnFailure: true
    })).rejects.toMatchObject({ cause: { code: "quota_refresh_superseded" } });
    expect(clearTokenAutomationErrorMock).not.toHaveBeenCalled();
  });

  it("filters scheduled quota by plan while retaining the current and active accounts", async () => {
    const saved = [
      { ...account, id: "active-free", planType: "free" },
      { ...account, id: "current-pro", isActive: false, planType: "pro" },
      { ...account, id: "business", isActive: false, planType: "chatgptteamplan" },
      { ...account, id: "other-free", isActive: false, planType: "free" }
    ];
    setCurrentWindowRuntimeAccountId("current-pro");
    const repo = {
      listAccounts: async () => saved,
      getAccount: async (id: string) => saved.find((item) => item.id === id),
      getFreshTokens: async () => tokens,
      updateQuota: async (id: string) => saved.find((item) => item.id === id),
      refreshSubscriptionState: async () => undefined
    };
    refreshQuotaMock.mockResolvedValue({});
    const service = new AccountsCommandService({} as vscode.ExtensionContext, repo as unknown as AccountsRepository, { refresh() {} });
    await service.refreshAllQuotas({ silent: true, backgroundPlanTypes: ["business"] });
    expect(refreshQuotaMock.mock.calls.map(([item]) => item.id)).toEqual(["active-free", "current-pro", "business"]);
    refreshQuotaMock.mockClear();
    await service.refreshAllQuotas({ backgroundPlanTypes: [] });
    expect(refreshQuotaMock.mock.calls.map(([item]) => item.id)).toContain("other-free");
  });

  it("persists refreshed subscription metadata from quota refresh results", async () => {
    const repo: QuotaRefreshRepo = {
      getAccount: vi.fn(async () => account),
      getFreshTokens: vi.fn(async () => tokens),
      updateQuota: vi.fn(async () => account),
      refreshSubscriptionState: vi.fn(async () => undefined),
      updateResetCreditsSnapshot: vi.fn(async () => undefined)
    };

    refreshQuotaMock.mockResolvedValue({
      quota: undefined,
      error: undefined,
      updatedTokens: tokens,
      updatedPlanType: "pro",
      updatedSubscriptionActiveUntil: "1800000000"
    });

    await refreshSingleQuota(repo as AccountsRepository, { refresh: vi.fn() }, account.id, {
      announce: false,
      refreshView: false,
      warnQuota: false,
      forceRefresh: true
    });

    expect(repo.updateQuota).toHaveBeenCalledWith(
      account.id,
      undefined,
      undefined,
      tokens,
      "pro",
      "1800000000",
      tokens,
      account,
      undefined,
      expect.any(Function)
    );
  });

  it("can wait for the subscription refresh before completing account info sync", async () => {
    let finishSubscriptionRefresh: (() => void) | undefined;
    const subscriptionRefresh = new Promise<void>((resolve) => {
      finishSubscriptionRefresh = resolve;
    });
    const repo: QuotaRefreshRepo = {
      getAccount: vi.fn(async () => account),
      getFreshTokens: vi.fn(async () => tokens),
      updateQuota: vi.fn(async () => account),
      refreshSubscriptionState: vi.fn(() => subscriptionRefresh),
      updateResetCreditsSnapshot: vi.fn(async () => undefined)
    };
    refreshQuotaMock.mockResolvedValue({ quota: undefined, error: undefined, updatedTokens: tokens });

    let completed = false;
    const refresh = refreshSingleQuota(repo as AccountsRepository, { refresh: vi.fn() }, account.id, {
      announce: false,
      awaitSubscriptionRefresh: true,
      forceRefresh: true,
      refreshView: false,
      warnQuota: false
    }).then(() => {
      completed = true;
    });

    await vi.waitFor(() => expect(repo.refreshSubscriptionState).toHaveBeenCalledWith(account.id, true));
    expect(completed).toBe(false);
    finishSubscriptionRefresh?.();
    await refresh;
    expect(completed).toBe(true);
  });

  it("keeps automation error when refresh still fails", async () => {
    const repo: QuotaRefreshRepo = {
      getAccount: vi.fn(async () => account),
      getFreshTokens: vi.fn(async () => tokens),
      updateQuota: vi.fn(async () => account),
      refreshSubscriptionState: vi.fn(async () => undefined),
      updateResetCreditsSnapshot: vi.fn(async () => undefined)
    };

    refreshQuotaMock.mockResolvedValue({
      error: {
        message: "Token refresh failed",
        timestamp: Math.floor(Date.now() / 1000)
      }
    });

    await refreshSingleQuota(repo as AccountsRepository, { refresh: vi.fn() }, account.id, {
      announce: false,
      refreshView: false,
      warnQuota: false,
      forceRefresh: true
    });

    expect(clearTokenAutomationErrorMock).not.toHaveBeenCalled();
  });

  it("fetches reset credits expiry from the updated quota snapshot", async () => {
    const updatedAccount: CodexAccountRecord = {
      ...account,
      accountId: "acct-1",
      quotaSummary: {
        hourlyPercentage: 82,
        hourlyWindowPresent: true,
        weeklyPercentage: 97,
        weeklyWindowPresent: true,
        resetCreditsAvailable: 1
      }
    };
    const repo: QuotaRefreshRepo = {
      getAccount: vi.fn(async () => account),
      getFreshTokens: vi.fn(async () => tokens),
      updateQuota: vi.fn(async () => updatedAccount),
      refreshSubscriptionState: vi.fn(async () => undefined),
      updateResetCreditsSnapshot: vi.fn(async () => undefined),
      refreshResetCreditInventory: vi.fn(async (current, load) => load(current))
    };
    const view = { refresh: vi.fn() };

    refreshQuotaMock.mockResolvedValue({
      quota: updatedAccount.quotaSummary,
      error: undefined,
      updatedTokens: tokens
    });
    fetchResetCreditsMock.mockResolvedValue({
      availableCount: 1,
      credits: [],
      nextExpiresAt: 1_800_000_000
    });

    await refreshSingleQuota(repo as AccountsRepository, view, account.id, {
      announce: false,
      refreshView: false,
      warnQuota: false,
      forceRefresh: true
    });
    await Promise.resolve();
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(fetchResetCreditsMock).toHaveBeenCalledWith(tokens.accessToken, "acct-1");
      expect(repo.refreshResetCreditInventory).toHaveBeenCalledWith(updatedAccount, expect.any(Function), undefined);
      expect(view.refresh).toHaveBeenCalled();
    });
  });

  it("still refreshes reset credits when the updated quota count is zero", async () => {
    const updatedAccount: CodexAccountRecord = {
      ...account,
      accountId: "acct-2",
      quotaSummary: {
        hourlyPercentage: 70,
        hourlyWindowPresent: true,
        weeklyPercentage: 95,
        weeklyWindowPresent: true,
        resetCreditsAvailable: 0,
        resetCreditsNextExpiresAt: 1_700_000_000
      }
    };
    const repo: QuotaRefreshRepo = {
      getAccount: vi.fn(async () => account),
      getFreshTokens: vi.fn(async () => tokens),
      updateQuota: vi.fn(async () => updatedAccount),
      refreshSubscriptionState: vi.fn(async () => undefined),
      updateResetCreditsSnapshot: vi.fn(async () => undefined),
      refreshResetCreditInventory: vi.fn(async (current, load) => load(current))
    };

    refreshQuotaMock.mockResolvedValue({
      quota: updatedAccount.quotaSummary,
      error: undefined,
      updatedTokens: tokens
    });
    fetchResetCreditsMock.mockResolvedValue({
      availableCount: 0,
      credits: [],
      nextExpiresAt: undefined
    });

    await refreshSingleQuota(repo as AccountsRepository, { refresh: vi.fn() }, account.id, {
      announce: false,
      refreshView: false,
      warnQuota: false,
      forceRefresh: true
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchResetCreditsMock).toHaveBeenCalledWith(tokens.accessToken, "acct-2");
    expect(repo.refreshResetCreditInventory).toHaveBeenCalledWith(updatedAccount, expect.any(Function), undefined);
  });

  it("auto-switches to the candidate with the best matching remaining quota", async () => {
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: vi.fn((key: string, defaultValue?: unknown) => {
        const values: Record<string, unknown> = {
          autoSwitchEnabled: true,
          autoSwitchHourlyThreshold: 20,
          autoSwitchWeeklyThreshold: 20
        };
        return values[key] ?? defaultValue;
      }),
      update: vi.fn()
    } as never);

    const active: CodexAccountRecord = {
      id: "active",
      email: "dev@example.com",
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
      quotaSummary: createQuotaSummary({ hourly: 90, weekly: 5 })
    };
    const sameEmailButLowerQuota: CodexAccountRecord = {
      id: "same-email-lower-quota",
      email: "dev@example.com",
      accountStructure: "organization",
      isActive: false,
      createdAt: 1,
      updatedAt: 1,
      quotaSummary: createQuotaSummary({ hourly: 100, weekly: 30 })
    };
    const bestQuota: CodexAccountRecord = {
      id: "best-quota",
      email: "other@example.com",
      accountStructure: "personal",
      isActive: false,
      createdAt: 1,
      updatedAt: 1,
      quotaSummary: createQuotaSummary({ hourly: 80, weekly: 85 })
    };
    const repo = {
      listAccounts: vi.fn(async () => [active, sameEmailButLowerQuota, bestQuota]),
      switchAccount: vi.fn(async () => undefined)
    };
    const view = {
      refresh: vi.fn(),
      markObservedAuthIdentity: vi.fn()
    };

    setCurrentWindowRuntimeAccountId(bestQuota.id);

    const switched = await maybeAutoSwitchForActiveQuota(repo as unknown as AccountsRepository, view);

    expect(switched).toBe(true);
    expect(repo.switchAccount).toHaveBeenCalledWith(bestQuota.id);
    expect(repo.switchAccount).not.toHaveBeenCalledWith(sameEmailButLowerQuota.id);
  });

  it("does not auto-switch for an hourly-only threshold when hourly quota control is disabled", async () => {
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: vi.fn((key: string, defaultValue?: unknown) => {
        const values: Record<string, unknown> = {
          autoSwitchEnabled: true,
          hourlyQuotaControlEnabled: false,
          autoSwitchHourlyThreshold: 20,
          autoSwitchWeeklyThreshold: 20
        };
        return values[key] ?? defaultValue;
      }),
      update: vi.fn()
    } as never);

    const active = createAccount("active", true, 0, 80);
    const candidate = createAccount("candidate", false, 100, 100);
    const repo = {
      listAccounts: vi.fn(async () => [active, candidate]),
      switchAccount: vi.fn(async () => undefined)
    };

    const switched = await maybeAutoSwitchForActiveQuota(repo as unknown as AccountsRepository, { refresh: vi.fn() });

    expect(switched).toBe(false);
    expect(repo.switchAccount).not.toHaveBeenCalled();
  });

  it("auto-switches for a valid hourly threshold when hourly quota control is enabled", async () => {
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: vi.fn((key: string, defaultValue?: unknown) => {
        const values: Record<string, unknown> = {
          autoSwitchEnabled: true,
          hourlyQuotaControlEnabled: true,
          autoSwitchHourlyThreshold: 20,
          autoSwitchWeeklyThreshold: 20
        };
        return values[key] ?? defaultValue;
      }),
      update: vi.fn()
    } as never);

    const active = createAccount("active", true, 0, 80);
    const exhausted = createAccount("exhausted", false, 100, 0);
    const candidate = createAccount("candidate", false, 70, 100);
    const repo = {
      listAccounts: vi.fn(async () => [active, exhausted, candidate]),
      switchAccount: vi.fn(async () => undefined)
    };

    const switched = await maybeAutoSwitchForActiveQuota(repo as unknown as AccountsRepository, { refresh: vi.fn() });

    expect(switched).toBe(true);
    expect(repo.switchAccount).toHaveBeenCalledWith(candidate.id);
  });

  it("auto reloads the window after auto switch when the setting is enabled", async () => {
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: vi.fn((key: string, defaultValue?: unknown) => {
        const values: Record<string, unknown> = {
          autoSwitchEnabled: true,
          autoSwitchReloadWindowEnabled: true,
          autoSwitchHourlyThreshold: 20,
          autoSwitchWeeklyThreshold: 20
        };
        return values[key] ?? defaultValue;
      }),
      update: vi.fn()
    } as never);

    const active: CodexAccountRecord = {
      id: "active",
      email: "dev@example.com",
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
      quotaSummary: createQuotaSummary({ hourly: 90, weekly: 5 })
    };
    const next: CodexAccountRecord = {
      id: "next-account",
      email: "next@example.com",
      isActive: false,
      createdAt: 1,
      updatedAt: 1,
      quotaSummary: createQuotaSummary({ hourly: 80, weekly: 85 })
    };
    const repo = {
      listAccounts: vi.fn(async () => [active, next]),
      switchAccount: vi.fn(async () => undefined)
    };
    const view = {
      refresh: vi.fn(),
      markObservedAuthIdentity: vi.fn()
    };

    setCurrentWindowRuntimeAccountId("other-window-account");
    autoReloadWindowForAccountMock.mockResolvedValue(true);

    const switched = await maybeAutoSwitchForActiveQuota(repo as unknown as AccountsRepository, view);

    expect(switched).toBe(true);
    expect(handleCodexAppRestartPreferenceMock).toHaveBeenCalledWith({ allowManualPrompt: false });
    expect(autoReloadWindowForAccountMock).toHaveBeenCalledWith(next.id);
  });
});

describe("quota warning window validation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("ignores the hourly quota while control is disabled and still warns for weekly quota", async () => {
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: vi.fn((key: string, defaultValue?: unknown) => {
        const values: Record<string, unknown> = {
          quotaWarningEnabled: true,
          hourlyQuotaControlEnabled: false,
          quotaWarningThreshold: 10
        };
        return values[key] ?? defaultValue;
      })
    } as never);
    const showWarning = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);
    showWarning.mockClear();
    const account = createAccount("active", true, 0, 5);
    const repo = { getAccount: vi.fn(async () => account) };

    await maybeWarnForAccount(repo as unknown as AccountsRepository, account.id);

    expect(showWarning).toHaveBeenCalledTimes(1);
    expect(showWarning.mock.calls[0]?.[0]).toContain("5%");
  });

  it("does not warn for missing hourly and weekly windows", async () => {
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: vi.fn((key: string, defaultValue?: unknown) => {
        const values: Record<string, unknown> = {
          quotaWarningEnabled: true,
          hourlyQuotaControlEnabled: true,
          quotaWarningThreshold: 10
        };
        return values[key] ?? defaultValue;
      })
    } as never);
    const showWarning = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);
    showWarning.mockClear();
    const account = createAccount("missing-windows", true, 0, 0);
    if (account.quotaSummary) {
      account.quotaSummary.hourlyWindowPresent = false;
      account.quotaSummary.weeklyWindowPresent = false;
    }
    const repo = { getAccount: vi.fn(async () => account) };

    await maybeWarnForAccount(repo as unknown as AccountsRepository, account.id);

    expect(showWarning).not.toHaveBeenCalled();
  });
});

function createAccount(id: string, isActive: boolean, hourly: number, weekly: number): CodexAccountRecord {
  return {
    id,
    email: `${id}@example.com`,
    isActive,
    createdAt: 1,
    updatedAt: 1,
    quotaSummary: createQuotaSummary({ hourly, weekly })
  };
}

function createQuotaSummary(values: { hourly: number; weekly: number }) {
  return {
    hourlyPercentage: values.hourly,
    hourlyWindowMinutes: 300,
    hourlyWindowPresent: true,
    weeklyPercentage: values.weekly,
    weeklyWindowMinutes: 10_080,
    weeklyWindowPresent: true,
    codeReviewPercentage: 0
  };
}
