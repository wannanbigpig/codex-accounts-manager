import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAccountRecord } from "../src/core/types";
import { registerAutoRefreshScheduler } from "../src/presentation/workbench/schedulerRegistration";
import type { AccountsRepository } from "../src/storage";

const minute = 60_000;
const account: CodexAccountRecord = { id: "account-a", email: "dev@example.com", isActive: false, createdAt: 1, updatedAt: 1 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  let minutes = 1;
  let configurationListener: ((event: vscode.ConfigurationChangeEvent) => unknown) | undefined;
  const configSubscription = { dispose: vi.fn() };
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
    get: (key: string, fallback?: unknown) => key === "autoRefreshMinutes" ? minutes : fallback
  } as vscode.WorkspaceConfiguration);
  vi.mocked(vscode.workspace.onDidChangeConfiguration).mockImplementation((listener) => {
    configurationListener = listener;
    return configSubscription;
  });
  const executeCommand = vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
  const listAccounts = vi.fn<AccountsRepository["listAccounts"]>().mockResolvedValue([account]);
  const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

  return {
    listAccounts,
    executeCommand,
    configSubscription,
    start: () => registerAutoRefreshScheduler({ context, repo: { listAccounts, runBackgroundQuotaBatch: (run: () => Promise<void>) => run() } as AccountsRepository, onRefresh: vi.fn() }),
    setMinutes(next: number): void {
      minutes = next;
      configurationListener?.({ affectsConfiguration: (key) => key === "codexAccounts.autoRefreshMinutes" });
    }
  };
}

describe("registerAutoRefreshScheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("skips interval and reconfiguration while the initial account lookup is pending", async () => {
    const view = fixture();
    const lookup = deferred<CodexAccountRecord[]>();
    view.listAccounts.mockReturnValue(lookup.promise);
    const scheduler = view.start();

    try {
      expect(view.listAccounts).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(minute);
      view.setMinutes(2);
      await vi.advanceTimersByTimeAsync(minute * 4);
      expect(view.listAccounts).toHaveBeenCalledTimes(1);
      expect(view.executeCommand).not.toHaveBeenCalled();

      lookup.resolve([account]);
      await vi.advanceTimersByTimeAsync(0);
      expect(view.executeCommand).toHaveBeenCalledExactlyOnceWith("codexAccounts.refreshAllQuotas", {
        silent: true, forceRefresh: true
      });
    } finally {
      scheduler.dispose();
    }
  });

  it("awaits the actual refresh batch and never queues skipped triggers", async () => {
    const view = fixture();
    const batch = deferred<undefined>();
    view.executeCommand.mockReturnValueOnce(batch.promise);
    const scheduler = view.start();

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(view.listAccounts).toHaveBeenCalledTimes(1);
      expect(view.executeCommand).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(minute * 2);
      view.setMinutes(2);
      await vi.advanceTimersByTimeAsync(minute * 4);
      expect(view.listAccounts).toHaveBeenCalledTimes(1);
      expect(view.executeCommand).toHaveBeenCalledTimes(1);

      batch.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(view.executeCommand).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(minute * 2);
      expect(view.executeCommand).toHaveBeenCalledTimes(2);
    } finally {
      scheduler.dispose();
    }
  });

  it("can recover from a rejected account lookup or refresh command", async () => {
    const view = fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    view.listAccounts.mockRejectedValueOnce(new Error("lookup failed"));
    view.executeCommand.mockRejectedValueOnce(new Error("command failed"));
    const scheduler = view.start();

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(view.executeCommand).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(minute);
      await vi.advanceTimersByTimeAsync(minute);
      expect(view.listAccounts).toHaveBeenCalledTimes(3);
      expect(view.executeCommand).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      scheduler.dispose();
    }
  });

  it("does not start a batch after disabling or disposing while the account lookup is pending", async () => {
    const view = fixture();
    const disabledLookup = deferred<CodexAccountRecord[]>();
    const disposedLookup = deferred<CodexAccountRecord[]>();
    view.listAccounts.mockReturnValueOnce(disabledLookup.promise).mockReturnValueOnce(disposedLookup.promise);
    const scheduler = view.start();

    view.setMinutes(0);
    disabledLookup.resolve([account]);
    await vi.advanceTimersByTimeAsync(minute);
    expect(view.executeCommand).not.toHaveBeenCalled();
    view.setMinutes(1);
    expect(view.listAccounts).toHaveBeenCalledTimes(2);

    scheduler.dispose();
    disposedLookup.resolve([account]);
    view.setMinutes(2);
    await vi.advanceTimersByTimeAsync(minute * 2);
    expect(view.listAccounts).toHaveBeenCalledTimes(2);
    expect(view.executeCommand).not.toHaveBeenCalled();
    expect(view.configSubscription.dispose).toHaveBeenCalledTimes(1);
  });
});
