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

import { maybeAutoSwitchForActiveQuota, maybeWarnForAccount, refreshSingleQuota } from "../src/application/accounts/quota";
import { setCurrentWindowRuntimeAccountId } from "../src/presentation/workbench/windowRuntimeAccount";

type QuotaRefreshRepo = Pick<
  AccountsRepository,
  "getAccount" | "getTokens" | "updateQuota" | "refreshSubscriptionState" | "updateResetCreditsSnapshot"
>;

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
      getTokens: vi.fn(async () => tokens),
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

  it("persists refreshed subscription metadata from quota refresh results", async () => {
    const repo: QuotaRefreshRepo = {
      getAccount: vi.fn(async () => account),
      getTokens: vi.fn(async () => tokens),
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
      "1800000000"
    );
  });

  it("can wait for the subscription refresh before completing account info sync", async () => {
    let finishSubscriptionRefresh: (() => void) | undefined;
    const subscriptionRefresh = new Promise<void>((resolve) => {
      finishSubscriptionRefresh = resolve;
    });
    const repo: QuotaRefreshRepo = {
      getAccount: vi.fn(async () => account),
      getTokens: vi.fn(async () => tokens),
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
      getTokens: vi.fn(async () => tokens),
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
      getTokens: vi.fn(async () => tokens),
      updateQuota: vi.fn(async () => updatedAccount),
      refreshSubscriptionState: vi.fn(async () => undefined),
      updateResetCreditsSnapshot: vi.fn(async () => undefined)
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

    expect(fetchResetCreditsMock).toHaveBeenCalledWith(tokens.accessToken, "acct-1");
    expect(repo.updateResetCreditsSnapshot).toHaveBeenCalledWith(account.id, 1, 1_800_000_000);
    expect(view.refresh).toHaveBeenCalled();
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
      getTokens: vi.fn(async () => tokens),
      updateQuota: vi.fn(async () => updatedAccount),
      refreshSubscriptionState: vi.fn(async () => undefined),
      updateResetCreditsSnapshot: vi.fn(async () => undefined)
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
    expect(repo.updateResetCreditsSnapshot).toHaveBeenCalledWith(account.id, 0, undefined);
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
    const candidate = createAccount("candidate", false, 100, 100);
    const repo = {
      listAccounts: vi.fn(async () => [active, candidate]),
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
