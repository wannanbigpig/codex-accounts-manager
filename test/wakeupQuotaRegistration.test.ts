import type * as vscode from "vscode";
import { beforeEach, expect, it, vi } from "vitest";
import type { CodexAccountRecord, CodexTokens } from "../src/core/types";
import type { WakeupExecutionResult, WakeupTaskInput } from "../src/domain/wakeup/types";
import { registerWakeupScheduler } from "../src/presentation/workbench/wakeupRegistration";
import type { AccountsRepository } from "../src/storage";

type ExecuteWakeup = (
  id: string,
  task: Pick<WakeupTaskInput, "model" | "effort" | "prompt" | "scheduleMode" | "quotaResetWindow">,
  signal: AbortSignal
) => Promise<WakeupExecutionResult>;

const { captureExecution, refreshQuota, sendWakeupRequest } = vi.hoisted(() => ({
  captureExecution: vi.fn<(execute: ExecuteWakeup) => void>(),
  refreshQuota: vi.fn(),
  sendWakeupRequest: vi.fn()
}));

vi.mock("../src/services", () => ({ refreshQuota }));
vi.mock("../src/services/wakeupClient", () => ({ sendWakeupRequest }));
vi.mock("../src/application/wakeup/service", () => ({
  WakeupService: class {
    constructor(_store: unknown, _repo: unknown, execute: ExecuteWakeup) {
      captureExecution(execute);
    }

    start = vi.fn();
    dispose = vi.fn();
  }
}));

beforeEach(() => vi.clearAllMocks());

it("retries an unauthorized post-wakeup quota request without rerunning the wakeup or switching accounts", async () => {
  const account: CodexAccountRecord = {
    id: "a", accountId: "workspace", email: "a@example.com", isActive: true, createdAt: 1, updatedAt: 1
  };
  const tokens: CodexTokens = { idToken: "id", accessToken: "original", refreshToken: "refresh", accountId: "workspace" };
  const renewed = { ...tokens, accessToken: "renewed" };
  const quota = { hourlyPercentage: 90, weeklyPercentage: 80, codeReviewPercentage: 100 };
  const repo = {
    getAccount: vi.fn(async () => account),
    getFreshTokens: vi.fn<AccountsRepository["getFreshTokens"]>().mockResolvedValueOnce(tokens)
      .mockResolvedValueOnce(tokens).mockResolvedValueOnce(renewed),
    updateQuota: vi.fn(async () => account),
    switchAccount: vi.fn()
  };
  sendWakeupRequest.mockResolvedValueOnce({ reply: "OK" });
  refreshQuota.mockResolvedValueOnce({ error: { statusCode: 401, message: "unauthorized", timestamp: 1 } })
    .mockResolvedValueOnce({ quota, updatedTokens: renewed });
  const subscriptions: vscode.Disposable[] = [];

  try {
    await registerWakeupScheduler({ subscriptions } as vscode.ExtensionContext, repo as unknown as AccountsRepository, vi.fn());
    const execute = captureExecution.mock.calls[0]![0];
    const result = await execute(account.id, { model: "test-model", effort: "low", prompt: "Reply with OK." }, new AbortController().signal);

    expect(result).toEqual({ reply: "OK", quotaWarning: undefined });
    expect(sendWakeupRequest).toHaveBeenCalledTimes(1);
    expect(refreshQuota.mock.calls).toEqual([[account, tokens, true], [account, renewed, true]]);
    expect(repo.getFreshTokens).toHaveBeenLastCalledWith(account.id, {
      force: true, expectedTokens: tokens, validateRefreshedTokens: expect.any(Function)
    });
    expect(repo.updateQuota).toHaveBeenCalledExactlyOnceWith(
      account.id, quota, undefined, renewed, undefined, undefined, renewed, account, undefined, expect.any(Function)
    );
    expect(repo.switchAccount).not.toHaveBeenCalled();
  } finally {
    subscriptions.forEach((subscription) => subscription.dispose());
  }
});

it.each([false, true])("only rechecks quota after wakeup and skips a newer valid snapshot (%s)", async (newer) => {
  vi.useFakeTimers();
  let account: CodexAccountRecord = { id: "recheck", accountId: "workspace", email: "a@example.test", isActive: false, createdAt: 1, updatedAt: 1 };
  const tokens = { idToken: "id", accessToken: "access", accountId: "workspace" };
  const quota = { hourlyPercentage: 90, weeklyPercentage: 80 };
  const repo = {
    getAccount: vi.fn(async () => account), getFreshTokens: vi.fn(async () => tokens),
    updateQuota: vi.fn(async (_id, next) => (account = { ...account, quotaSummary: next })),
    switchAccount: vi.fn(), refreshSubscriptionState: vi.fn(), refreshResetCreditInventory: vi.fn()
  };
  const subscriptions: vscode.Disposable[] = [];
  sendWakeupRequest.mockResolvedValue({ reply: "OK" });
  refreshQuota.mockResolvedValue({ quota });
  try {
    await registerWakeupScheduler({ subscriptions } as vscode.ExtensionContext, repo as unknown as AccountsRepository, vi.fn());
    const execute = captureExecution.mock.calls[0]![0];
    await execute(account.id, { model: "test-model", effort: "low", prompt: "OK", scheduleMode: "quota_reset", quotaResetWindow: "hourly" }, new AbortController().signal);
    expect(refreshQuota).toHaveBeenCalledTimes(1);
    if (newer) {
      account = { ...account, quotaSummary: { ...quota, hourlyResetTime: Math.floor(Date.now() / 1000) + 1800 } };
    }
    await vi.advanceTimersByTimeAsync(90_000);
    expect(refreshQuota).toHaveBeenCalledTimes(newer ? 1 : 2);
    expect(sendWakeupRequest).toHaveBeenCalledTimes(1);
    expect(repo.switchAccount).not.toHaveBeenCalled();
    expect(repo.refreshSubscriptionState).not.toHaveBeenCalled();
    expect(repo.refreshResetCreditInventory).not.toHaveBeenCalled();
  } finally {
    subscriptions.forEach((subscription) => subscription.dispose());
    vi.useRealTimers();
  }
});
