import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import type { CodexAccountRecord, CodexTokens } from "../src/core/types";
import type { AccountsRepository } from "../src/storage";

const { refreshQuotaMock, clearTokenAutomationErrorMock } = vi.hoisted(() => ({
  refreshQuotaMock: vi.fn(),
  clearTokenAutomationErrorMock: vi.fn()
}));

vi.mock("../src/services", () => ({
  refreshQuota: refreshQuotaMock
}));

vi.mock("../src/presentation/workbench/tokenAutomationState", () => ({
  clearTokenAutomationError: clearTokenAutomationErrorMock
}));

import { maybeAutoSwitchForActiveQuota, refreshSingleQuota } from "../src/application/accounts/quota";
import { setCurrentWindowRuntimeAccountId } from "../src/presentation/workbench/windowRuntimeAccount";

type QuotaRefreshRepo = Pick<AccountsRepository, "getAccount" | "getTokens" | "updateQuota">;

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
    clearTokenAutomationErrorMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setCurrentWindowRuntimeAccountId(undefined);
  });

  it("clears automation auth error after a successful manual refresh", async () => {
    const repo: QuotaRefreshRepo = {
      getAccount: vi.fn(async () => account),
      getTokens: vi.fn(async () => tokens),
      updateQuota: vi.fn(async () => account)
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
      updateQuota: vi.fn(async () => account)
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

  it("keeps automation error when refresh still fails", async () => {
    const repo: QuotaRefreshRepo = {
      getAccount: vi.fn(async () => account),
      getTokens: vi.fn(async () => tokens),
      updateQuota: vi.fn(async () => account)
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
});

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
