import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { DashboardActionContext } from "../src/presentation/dashboard/actionHandlers";
import type { CodexAccountRecord } from "../src/core/types";
import { AccountsRepository } from "../src/storage";
import { QUOTA_USAGE_URL, RESET_CREDITS_CONSUME_URL, RESET_CREDITS_HISTORY_URL, RESET_CREDITS_URL } from "../src/infrastructure/config/apiEndpoints";
import { getBackupPath } from "../src/storage/accountsIndex";

const { fetchWithTimeoutMock } = vi.hoisted(() => ({
  fetchWithTimeoutMock: vi.fn()
}));

vi.mock("../src/utils/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/network")>()),
  fetchWithTimeout: fetchWithTimeoutMock
}));

import { executeDashboardActionMessage } from "../src/presentation/dashboard/actionHandlers";
import { refreshResetCreditInventory } from "../src/application/accounts/resetCreditInventory";
import { backfillMissingResetCreditExpiries } from "../src/presentation/dashboard/resetCreditsBackfill";

const resetAction = {
  type: "dashboard:action",
  action: "consumeResetCredit",
  requestId: "reset-ui-action",
  accountId: "account-1"
} as const;

async function withResetAccount(
  run: (openContext: () => DashboardActionContext) => Promise<void>,
  workspace: Pick<CodexAccountRecord, "accountId" | "organizationId" | "userId"> = { accountId: "acct-1" }
): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-reset-redemption-"));
  const repos: AccountsRepository[] = [];
  const openContext = (): DashboardActionContext => {
    const context = { globalStorageUri: { fsPath: directory }, secrets: { get: async () => undefined } } as vscode.ExtensionContext;
    const repo = new AccountsRepository(context);
    repos.push(repo);
    vi.spyOn(repo, "getFreshTokens").mockResolvedValue({ accessToken: "access-token", idToken: "id-token", accountId: "acct-1" });
    return {
      context,
      repo,
      resolveLanguage: () => "en",
      schedulePublishState: vi.fn(),
      publishState: vi.fn(),
      oauth: {} as DashboardActionContext["oauth"],
      announcements: {} as DashboardActionContext["announcements"],
      getAnnouncementOptions: () => ({ version: "0.1.21", locale: "en" })
    };
  };
  const confirm = vi.mocked(vscode.window.showWarningMessage).mockImplementation(async (...args: unknown[]) => args[2] as never);
  vi.mocked(vscode.window.showInformationMessage).mockClear();
  vi.mocked(vscode.commands.executeCommand).mockClear().mockResolvedValue(undefined);
  fetchWithTimeoutMock.mockReset();
  try {
    await fs.writeFile(path.join(directory, "accounts-index.json"), JSON.stringify({
      accounts: [{
        ...workspace, id: "account-1", email: "dev@example.com", isActive: false,
        createdAt: 1, updatedAt: 1, quotaSummary: { resetCreditsAvailable: 1 }
      }]
    }));
    await run(openContext);
  } finally {
    confirm.mockReset();
    for (const repo of repos) {
      repo.dispose();
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}

describe("executeDashboardActionMessage", () => {
  it("counts a profile sync with a rejected quota as partial", async () => {
    await withResetAccount(async (openContext) => {
      const ctx = openContext();
      const account = (await ctx.repo.getAccount("account-1"))!;
      vi.spyOn(ctx.repo, "refreshAccountProfileMetadata").mockResolvedValue(account);
      vi.spyOn(ctx.repo, "updateQuota").mockResolvedValue(account);
      vi.spyOn(ctx.repo, "refreshSubscriptionState").mockResolvedValue(undefined);
      fetchWithTimeoutMock.mockResolvedValueOnce(Response.json({ detail: { code: "permission_denied" } }, { status: 403 }));
      const result = await executeDashboardActionMessage(ctx, {
        type: "dashboard:action", action: "batchResyncProfile", requestId: "sync", payload: { accountIds: [account.id] }
      });
      expect(result.payload?.batchResult).toMatchObject({ successCount: 0, partialCount: 1, failedCount: 0,
        failures: [{ accountId: account.id, outcome: "partial", message: expect.stringContaining("permission_denied") }] });
    });
  });

  it("retains a dashboard move on disk and ignores an unknown target", async () => {
    await withResetAccount(async (openContext) => {
      const ctx = openContext();
      const account = (await ctx.repo.getAccount("account-1"))!;
      const file = path.join(ctx.context.globalStorageUri.fsPath, "accounts-index.json");
      await fs.writeFile(file, JSON.stringify({ accounts: [account, { ...account, id: "account-2", createdAt: 2 }] }));
      const request = { type: "dashboard:action", action: "moveDashboardAccount", requestId: "move", accountId: account.id } as const;
      await executeDashboardActionMessage(ctx, { ...request, payload: { moveTargetAccountId: "account-2" } });
      await executeDashboardActionMessage(ctx, { ...request, payload: { moveTargetAccountId: "missing", moveAfter: true } });
      expect(await openContext().repo.getDashboardAccountOrder()).toEqual(["account-1", "account-2"]);
    });
  });

  it("reports the host's device cancellation result to the webview", async () => {
    await withResetAccount(async (openContext) => {
      const ctx = openContext();
      const cancelDeviceSession = vi.fn(() => "committing" as const);
      ctx.oauth = { cancelDeviceSession } as unknown as DashboardActionContext["oauth"];
      await expect(executeDashboardActionMessage(ctx, {
        type: "dashboard:action", action: "cancelDeviceOAuthSession", requestId: "cancel-request",
        payload: { deviceSessionId: "device-session" }
      })).resolves.toMatchObject({ status: "completed", payload: { deviceOAuthCancellation: "committing" } });
      expect(cancelDeviceSession).toHaveBeenCalledWith("device-session");
    });
  });

  it.each([false, true])("returns whether the browser opened the verification URL (%s)", async (opened) => {
    await withResetAccount(async (openContext) => {
      const url = "https://auth.openai.com/codex/device";
      const openExternal = vi.mocked(vscode.env.openExternal).mockResolvedValueOnce(opened);
      await expect(executeDashboardActionMessage(openContext(), {
        type: "dashboard:action", action: "openExternalUrl", requestId: "open-device-page", payload: { url }
      })).resolves.toMatchObject({ status: "completed", payload: { externalUrlOpened: opened } });
      expect(String(openExternal.mock.lastCall?.[0])).toBe(url);
    });
  });

  it("only probes selected entries and leaves a recoverable index, auth file and secrets untouched before import", async () => {
    await withResetAccount(async (openContext) => {
      const ctx = openContext();
      const dir = ctx.context.globalStorageUri.fsPath;
      const index = path.join(dir, "accounts-index.json");
      const auth = path.join(dir, "auth.json");
      await fs.copyFile(index, getBackupPath(index, 1));
      await fs.writeFile(index, "corrupt but recoverable");
      await fs.writeFile(auth, "keep auth");
      const files = await fs.readdir(dir);
      const credentialsRead = vi.spyOn(ctx.context.secrets, "get");
      const makeEntry = (id: string) => {
        const claims = Buffer.from(JSON.stringify({ email: "same@example.test", "https://api.openai.com/auth": {
          chatgpt_account_id: id, organization_id: `org-${id}`
        } })).toString("base64url");
        return { tokens: { id_token: `A.${claims}.one`, access_token: `A.${claims}.two`, refresh_token: "never-used" } };
      };
      const jsonText = JSON.stringify([makeEntry("zero"), makeEntry("expired"), makeEntry("limited"), makeEntry("unselected"), {}]);
      fetchWithTimeoutMock.mockImplementation(async (url, init) => {
        expect(url).toBe(QUOTA_USAGE_URL);
        expect(init.method).toBe("GET");
        const scope = new Headers(init.headers).get("ChatGPT-Account-Id");
        if (scope === "zero") {
          return Response.json({ organization_id: "org-zero", rate_limit: { primary_window: { used_percent: 100 } } });
        }
        if (scope === "expired") {
          return new Response(null, { status: 401 });
        }
        expect(scope).toBe("limited");
        return new Response(null, { status: 429, headers: { "Retry-After": "120" } });
      });

      const action = { type: "dashboard:action", action: "previewImportSharedJson", requestId: "probe" } as const;
      await expect(executeDashboardActionMessage(ctx, { ...action, payload: { jsonText } })).resolves.toMatchObject({ status: "completed" });
      expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
      const probed = await executeDashboardActionMessage(ctx, { ...action, accountId: "ignored", payload: { jsonText, probeImportIndexes: [2, 0, 1, 1, 4] } });
      expect(probed.payload?.importPreview?.quotaProbes).toEqual([
        { index: 0, status: "available", hourlyPercentage: 0, weeklyPercentage: undefined },
        { index: 1, status: "unauthorized" },
        { index: 2, status: "rate_limited" }
      ]);
      expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(3);
      expect(credentialsRead).not.toHaveBeenCalled();
      expect(await fs.readFile(index, "utf8")).toBe("corrupt but recoverable");
      expect(await fs.readFile(auth, "utf8")).toBe("keep auth");
      expect(await fs.readdir(dir)).toEqual(files);
    });
  });

  it("forces a panel state publish for refreshView", async () => {
    const publishState = vi.fn().mockResolvedValue(undefined);
    const result = await executeDashboardActionMessage(
      {
        context: {} as DashboardActionContext["context"],
        repo: {} as DashboardActionContext["repo"],
        resolveLanguage: () => "en",
        schedulePublishState: vi.fn(),
        publishState,
        oauth: {} as DashboardActionContext["oauth"],
        announcements: {} as DashboardActionContext["announcements"],
        getAnnouncementOptions: () => ({
          version: "0.1.15",
          locale: "en"
        })
      },
      {
        type: "dashboard:action",
        action: "refreshView",
        requestId: "req-1"
      }
    );

    expect(publishState).toHaveBeenCalledWith(true);
    expect(result.status).toBe("completed");
  });

  it("waits for quota refresh after consuming a reset credit", async () => {
    await withResetAccount(async (openContext) => {
      const ctx = openContext();
      fetchWithTimeoutMock.mockResolvedValueOnce(Response.json({ code: "reset" }))
        .mockResolvedValueOnce(Response.json({ available_count: 0 }));
      vi.mocked(vscode.commands.executeCommand).mockImplementationOnce(async () => {
        expect((await ctx.repo.getAccount("account-1"))?.quotaSummary?.resetCreditsAvailable).toBe(0);
      });
      const result = await executeDashboardActionMessage(ctx, resetAction);
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith("codexAccounts.refreshQuota", expect.objectContaining({ id: "account-1" }));
      expect(result).toMatchObject({
        status: "completed",
        payload: { resetCreditHistoryChanged: true, resetCredits: { availableCount: 0, credits: [] } }
      });
      expect(fetchWithTimeoutMock.mock.calls.map(([url]) => url)).toEqual([RESET_CREDITS_CONSUME_URL, RESET_CREDITS_URL]);
      expect((await ctx.repo.getAccount("account-1"))?.quotaSummary?.resetCreditsAvailable).toBe(0);
    });
  });

  it("keeps the freshly redeemed inventory when usage still reports the earlier count", async () => {
    await withResetAccount(async (openContext) => {
      const ctx = openContext();
      const account = (await ctx.repo.getAccount("account-1"))!;
      fetchWithTimeoutMock.mockResolvedValueOnce(Response.json({ available_count: 1 }))
        .mockResolvedValueOnce(Response.json({ code: "reset" }))
        .mockResolvedValueOnce(Response.json({ available_count: 0 }));
      await refreshResetCreditInventory(ctx.repo, account);
      vi.mocked(vscode.commands.executeCommand).mockImplementationOnce(async () => {
        await ctx.repo.updateQuota(account.id, { hourlyPercentage: 100, weeklyPercentage: 100, resetCreditsAvailable: 1 });
      });

      expect(await executeDashboardActionMessage(ctx, resetAction)).toMatchObject({ status: "completed" });
      const refreshed = (await ctx.repo.getAccount(account.id))!;
      expect(refreshed.quotaSummary?.resetCreditsAvailable).toBe(0);
      expect(await refreshResetCreditInventory(ctx.repo, refreshed)).toBeUndefined();
      expect(fetchWithTimeoutMock.mock.calls.map(([url]) => url)).toEqual([
        RESET_CREDITS_URL, RESET_CREDITS_CONSUME_URL, RESET_CREDITS_URL
      ]);

      await ctx.repo.updateQuota(account.id, { hourlyPercentage: 100, weeklyPercentage: 100, resetCreditsAvailable: 2 });
      fetchWithTimeoutMock.mockResolvedValueOnce(Response.json({ available_count: 2 }));
      expect(await refreshResetCreditInventory(ctx.repo, (await ctx.repo.getAccount(account.id))!)).toMatchObject({ availableCount: 2 });
      expect((await ctx.repo.getAccount(account.id))?.quotaSummary?.resetCreditsAvailable).toBe(2);
    });
  });

  it("shares one inventory read across concurrent background and Dashboard refreshes and reopening", async () => {
    await withResetAccount(async (openContext) => {
      const first = openContext();
      const second = openContext();
      const saved = (await first.repo.getAccount("account-1"))!;
      let finishInventory!: (response: Response) => void;
      fetchWithTimeoutMock.mockReturnValueOnce(new Promise<Response>((resolve) => { finishInventory = resolve; }));
      const background = refreshResetCreditInventory(first.repo, saved);
      try {
        await vi.waitFor(() => expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1));
        const panel = backfillMissingResetCreditExpiries(second.repo, [
          { id: saved.id, accountId: saved.accountId, resetCreditsAvailable: 1 } as never
        ], vi.fn());
        finishInventory(Response.json({ available_count: 0 }));
        expect(await background).toMatchObject({ availableCount: 0 });
        expect(await panel).toBe(false);

        const reopened = openContext();
        const latest = (await reopened.repo.getAccount(saved.id))!;
        expect(latest.quotaSummary?.resetCreditsAvailable).toBe(0);
        expect(latest.resetCreditInventory?.refreshAt).toBeGreaterThan(Date.now());
        expect(await refreshResetCreditInventory(reopened.repo, latest)).toBeUndefined();
        expect(fetchWithTimeoutMock.mock.calls.map(([url]) => url)).toEqual([RESET_CREDITS_URL]);
      } finally {
        finishInventory(Response.json({ available_count: 0 }));
        await background.catch(() => undefined);
      }
    });
  });

  it("skips an overlapping background quota batch in another repository host", async () => {
    await withResetAccount(async (openContext) => {
      const first = openContext();
      const second = openContext();
      let finishBatch!: () => void;
      const held = new Promise<void>((resolve) => { finishBatch = resolve; });
      const running = vi.fn(() => held);
      const skipped = vi.fn(async () => undefined);
      const batch = first.repo.runBackgroundQuotaBatch(running);
      try {
        await vi.waitFor(() => expect(running).toHaveBeenCalledTimes(1));
        await second.repo.runBackgroundQuotaBatch(skipped);
        expect(skipped).not.toHaveBeenCalled();
      } finally {
        finishBatch();
        await batch;
      }
      await second.repo.runBackgroundQuotaBatch(skipped);
      expect(skipped).toHaveBeenCalledTimes(1);
    });
  });

  it("retries a timed-out redemption with the same ID after reopening the extension at zero remaining credits", async () => {
    await withResetAccount(async (openContext) => {
      const first = openContext();
      const postedIds: string[] = [];
      fetchWithTimeoutMock.mockImplementation(async (url: string, init: RequestInit) => {
        if (url === RESET_CREDITS_URL) return Response.json({ available_count: 0 });
        expect(url).toBe(RESET_CREDITS_CONSUME_URL);
        expect(new Headers(init.headers).get("ChatGPT-Account-Id")).toBe("acct-1");
        const { redeem_request_id: id } = JSON.parse(String(init.body)) as { redeem_request_id: string };
        postedIds.push(id);
        if (postedIds.length === 1) {
          expect((await first.repo.getAccount("account-1"))?.resetCreditRedemption).toMatchObject({ requestId: id, pending: true });
          throw new Error("Consume reset credit timed out after 15s");
        }
        return Response.json({ code: "already_redeemed" });
      });

      expect(await executeDashboardActionMessage(first, resetAction)).toMatchObject({
        status: "failed", errorMessage: expect.stringContaining("unconfirmed")
      });
      const localHistory = { ...resetAction, action: "getLocalResetCreditHistory" as const };
      expect((await executeDashboardActionMessage(first, localHistory)).payload?.localResetCreditHistory).toEqual([
        { requestId: postedIds[0], occurredAt: expect.any(Number), outcome: "pending" }
      ]);
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
      expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
      await first.repo.updateResetCreditsSnapshot("account-1", 0);
      first.repo.dispose();

      const reopened = openContext();
      expect(await executeDashboardActionMessage(reopened, resetAction)).toMatchObject({ status: "completed" });
      expect(postedIds).toEqual([expect.any(String), postedIds[0]]);
      expect((await reopened.repo.getAccount("account-1"))?.resetCreditRedemption).toMatchObject({ requestId: postedIds[0], pending: false });
      expect((await executeDashboardActionMessage(reopened, localHistory)).payload?.localResetCreditHistory).toEqual([
        { requestId: postedIds[0], occurredAt: expect.any(Number), outcome: "already_redeemed" }
      ]);
      expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(1);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    });
  });

  it("retries only the selected credit with the same request ID after reopening and refreshing inventory", async () => {
    await withResetAccount(async (openContext) => {
      const inventoryAction = { ...resetAction, action: "getResetCredits" } as const;
      const firstCredit = { id: "first-credit", status: "available" };
      const secondCredit = { id: "second-credit", status: "available" };
      const first = openContext();
      fetchWithTimeoutMock.mockResolvedValueOnce(Response.json({ available_count: 2, credits: [firstCredit, secondCredit] }));
      expect((await executeDashboardActionMessage(first, inventoryAction)).status).toBe("completed");

      const selected = { ...resetAction, payload: { resetCreditId: secondCredit.id } };
      fetchWithTimeoutMock.mockRejectedValueOnce(new Error("Consume reset credit timed out after 15s"));
      expect(await executeDashboardActionMessage(first, selected)).toMatchObject({ status: "failed", errorMessage: expect.stringContaining("unconfirmed") });
      const attempt = (await first.repo.getAccount("account-1"))?.resetCreditRedemption;
      expect(attempt).toMatchObject({ creditId: secondCredit.id, pending: true, requestId: expect.any(String) });
      first.repo.dispose();

      const reopened = openContext();
      fetchWithTimeoutMock.mockResolvedValueOnce(Response.json({ available_count: 1, credits: [firstCredit] }));
      expect((await executeDashboardActionMessage(reopened, inventoryAction)).status).toBe("completed");
      expect(await executeDashboardActionMessage(reopened, { ...resetAction, payload: { resetCreditId: firstCredit.id } })).toMatchObject({
        status: "failed", errorMessage: expect.stringContaining("Confirm the previous reset")
      });
      expect(fetchWithTimeoutMock.mock.calls.filter(([url]) => url === RESET_CREDITS_CONSUME_URL)).toHaveLength(1);

      fetchWithTimeoutMock.mockResolvedValueOnce(Response.json({ code: "already_redeemed" }))
        .mockResolvedValueOnce(Response.json({ available_count: 1, credits: [firstCredit] }));
      expect(await executeDashboardActionMessage(reopened, selected)).toMatchObject({
        status: "completed", payload: { resetCredits: { availableCount: 1, credits: [firstCredit] } }
      });
      const posts = fetchWithTimeoutMock.mock.calls.filter(([url]) => url === RESET_CREDITS_CONSUME_URL)
        .map(([, request]) => request as RequestInit);
      expect(posts).toHaveLength(2);
      expect(posts.map((request) => JSON.parse(String(request.body)))).toEqual([
        { redeem_request_id: attempt?.requestId, credit_id: secondCredit.id },
        { redeem_request_id: attempt?.requestId, credit_id: secondCredit.id }
      ]);
      expect(posts.every((request) => new Headers(request.headers).get("ChatGPT-Account-Id") === "acct-1")).toBe(true);
      expect((await reopened.repo.getAccount("account-1"))?.resetCreditRedemption?.pending).toBe(false);
    });
  });

  it("does not fall back to account-level redemption when the selected credit is unavailable", async () => {
    await withResetAccount(async (openContext) => {
      const context = openContext();
      fetchWithTimeoutMock.mockResolvedValueOnce(Response.json({ available_count: 1, credits: [
        { id: "available", status: "available" }, { id: "used", status: "redeemed" }
      ] }));
      await executeDashboardActionMessage(context, { ...resetAction, action: "getResetCredits" });

      for (const resetCreditId of ["used", "other-workspace-credit"]) {
        expect(await executeDashboardActionMessage(context, { ...resetAction, payload: { resetCreditId } })).toMatchObject({
          status: "failed", errorMessage: expect.stringContaining("no longer available")
        });
      }
      expect(fetchWithTimeoutMock.mock.calls.map(([url]) => url)).toEqual([RESET_CREDITS_URL]);
      expect((await context.repo.getAccount("account-1"))?.resetCreditRedemption).toBeUndefined();
    });
  });

  it("does not submit a second exchange when another window confirms the same old account state", async () => {
    await withResetAccount(async (openContext) => {
      const first = openContext();
      const second = openContext();
      const confirmations: Array<() => void> = [];
      vi.mocked(vscode.window.showWarningMessage).mockImplementation((...args: unknown[]) => {
        if (typeof args[2] !== "string") {
          return Promise.resolve(undefined);
        }
        return new Promise((resolve) => confirmations.push(() => resolve(args[2] as never)));
      });
      fetchWithTimeoutMock.mockResolvedValueOnce(Response.json({ code: "reset" }))
        .mockResolvedValueOnce(Response.json({ available_count: 0 }));

      const firstAction = executeDashboardActionMessage(first, resetAction);
      const secondAction = executeDashboardActionMessage(second, resetAction);
      await vi.waitFor(() => expect(confirmations).toHaveLength(2));
      confirmations.forEach((confirm) => confirm());

      const results = await Promise.all([firstAction, secondAction]);
      expect(results.map((result) => result.status).sort()).toEqual(["completed", "failed"]);
      expect(results.find((result) => result.status === "failed")?.errorMessage).toContain("another window");
      expect(fetchWithTimeoutMock.mock.calls.map(([url]) => url)).toEqual([RESET_CREDITS_CONSUME_URL, RESET_CREDITS_URL]);
      expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(1);
    });
  });

  it("uses the token workspace for a legacy account and preserves its pending ID after metadata is filled", async () => {
    await withResetAccount(async (openContext) => {
      const first = openContext();
      const auth = { chatgpt_account_id: "acct-1", organization_id: "org-1", chatgpt_user_id: "user-1" };
      const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": auth })).toString("base64url");
      const tokens = { accessToken: `header.${payload}.signature`, idToken: `header.${payload}.signature` };
      vi.mocked(first.repo.getFreshTokens).mockResolvedValue(tokens);
      fetchWithTimeoutMock
        .mockRejectedValueOnce(new Error("Consume reset credit timed out after 15s"))
        .mockResolvedValueOnce(Response.json({ code: "already_redeemed" }))
        .mockResolvedValueOnce(Response.json({ available_count: 0 }));

      expect(await executeDashboardActionMessage(first, resetAction)).toMatchObject({ status: "failed" });
      const stored = await first.repo.getAccount("account-1");
      expect(stored?.resetCreditRedemption).toMatchObject({ pending: true, accountId: "acct-1", organizationId: "org-1", userId: "user-1" });
      await fs.writeFile(path.join(first.context.globalStorageUri.fsPath, "accounts-index.json"), JSON.stringify({
        accounts: [{ ...stored, accountId: "acct-1", organizationId: "org-1", userId: "user-1" }]
      }));
      const reopened = openContext();
      vi.mocked(reopened.repo.getFreshTokens).mockResolvedValue(tokens);

      expect(await executeDashboardActionMessage(reopened, resetAction)).toMatchObject({ status: "completed" });
      const requests = fetchWithTimeoutMock.mock.calls.filter(([url]) => url === RESET_CREDITS_CONSUME_URL)
        .map(([, request]) => request as RequestInit);
      expect(requests).toHaveLength(2);
      expect(requests.every((request) => new Headers(request.headers).get("ChatGPT-Account-Id") === "acct-1")).toBe(true);
      expect(requests[1]?.body).toBe(requests[0]?.body);
    }, {});
  });

  it("does not send a reset POST when the workspace is missing from both the saved account and credentials", async () => {
    await withResetAccount(async (openContext) => {
      const context = openContext();
      vi.mocked(context.repo.getFreshTokens).mockResolvedValue({ accessToken: "access-token", idToken: "id-token" });

      expect(await executeDashboardActionMessage(context, resetAction)).toMatchObject({
        status: "failed", errorMessage: expect.stringContaining("workspace could not be identified")
      });
      expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
      expect((await context.repo.getAccount("account-1"))?.resetCreditRedemption).toBeUndefined();
    }, {});
  });

  it.each(["nothing_to_reset", "no_credit"])("settles %s without a success notification", async (code) => {
    await withResetAccount(async (openContext) => {
      const context = openContext();
      fetchWithTimeoutMock.mockResolvedValueOnce(Response.json({ code }))
        .mockResolvedValueOnce(Response.json({ available_count: 0 }));

      await executeDashboardActionMessage(context, resetAction);

      expect((await context.repo.getAccount("account-1"))?.resetCreditRedemption?.pending).toBe(false);
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
      expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(1);
    });
  });

  it("uses the same request and selected credit IDs for the single 401 refresh and replay", async () => {
    await withResetAccount(async (openContext) => {
      const context = openContext();
      fetchWithTimeoutMock.mockResolvedValueOnce(Response.json({ available_count: 1, credits: [{ id: "credit-1" }] }));
      await executeDashboardActionMessage(context, { ...resetAction, action: "getResetCredits" });
      const getFreshTokens = vi.mocked(context.repo.getFreshTokens);
      getFreshTokens
        .mockResolvedValueOnce({ accessToken: "old-token", idToken: "id-token", refreshToken: "refresh-token" })
        .mockResolvedValueOnce({ accessToken: "new-token", idToken: "id-token" });
      fetchWithTimeoutMock
        .mockResolvedValueOnce(Response.json({ detail: { code: "token_expired" } }, { status: 401 }))
        .mockResolvedValueOnce(Response.json({ code: "reset" }))
        .mockResolvedValueOnce(Response.json({ available_count: 0 }));

      expect(await executeDashboardActionMessage(context, { ...resetAction, payload: { resetCreditId: "credit-1" } })).toMatchObject({ status: "completed" });

      const requests = fetchWithTimeoutMock.mock.calls.filter(([url]) => url === RESET_CREDITS_CONSUME_URL)
        .map(([, request]) => request as RequestInit);
      expect(requests).toHaveLength(2);
      expect(requests.map((request) => new Headers(request.headers).get("Authorization"))).toEqual(["Bearer old-token", "Bearer new-token"]);
      expect(JSON.parse(String(requests[0]?.body))).toMatchObject({ redeem_request_id: expect.any(String), credit_id: "credit-1" });
      expect(requests[1]?.body).toBe(requests[0]?.body);
    });
  });

  it("loads reset history only for the requested account and preserves pagination through a 401 retry", async () => {
    await withResetAccount(async (openContext) => {
      const context = openContext();
      const oldTokens = { accessToken: "old-token", idToken: "id-token", refreshToken: "refresh-token" };
      const newTokens = { ...oldTokens, accessToken: "new-token" };
      vi.mocked(context.repo.getFreshTokens)
        .mockResolvedValueOnce(oldTokens)
        .mockResolvedValueOnce(oldTokens)
        .mockResolvedValueOnce(newTokens);
      const opaqueCursor = "opaque+/=%? 中文 ";
      fetchWithTimeoutMock
        .mockResolvedValueOnce(Response.json({
          events: [{ id: "grant-1", kind: "granted", occurred_at: "2026-11-02T00:00:00Z" }],
          next_cursor: opaqueCursor
        }))
        .mockResolvedValueOnce(new Response(null, { status: 401 }))
        .mockResolvedValueOnce(Response.json({
          events: [{ id: "redeem-1", kind: "redeemed", occurred_at: "2026-11-01T00:00:00Z" }],
          next_cursor: null
        }));

      const action = { ...resetAction, action: "getResetCreditHistory" } as const;
      const first = await executeDashboardActionMessage(context, action);
      expect(first.payload?.resetCreditHistory).toEqual({
        events: [{ id: "grant-1", kind: "granted", occurredAt: "2026-11-02T00:00:00Z" }],
        nextCursor: opaqueCursor
      });

      const next = await executeDashboardActionMessage(context, {
        ...action, requestId: "next-page", payload: { resetCreditHistoryCursor: first.payload?.resetCreditHistory?.nextCursor }
      });
      expect(next.payload?.resetCreditHistory).toEqual({
        events: [{ id: "redeem-1", kind: "redeemed", occurredAt: "2026-11-01T00:00:00Z" }]
      });
      const requests = fetchWithTimeoutMock.mock.calls.map(([input, init]) => ({ url: new URL(String(input)), init: init as RequestInit }));
      expect(requests.map(({ url }) => url.searchParams.get("cursor"))).toEqual([null, opaqueCursor, opaqueCursor]);
      expect(requests.every(({ url, init }) =>
        url.origin + url.pathname === RESET_CREDITS_HISTORY_URL && init.method === "GET" &&
        new Headers(init.headers).get("ChatGPT-Account-Id") === "acct-1"
      )).toBe(true);
      expect(new Headers(requests[2]?.init.headers).get("Authorization")).toBe("Bearer new-token");
      expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
      expect((await context.repo.getAccount("account-1"))?.resetCreditRedemption).toBeUndefined();
    });
  });

  it("reports the reason for each failed selected account without counting it as refreshed", async () => {
    const accounts = [
      { id: "batch-healthy", email: "healthy@example.com" },
      { id: "batch-rejected", email: "rejected@example.com" }
    ];
    const getAccount = (id: string) => accounts.find((account) => account.id === id);
    const tokenFor = (id: string) => `eyJhbGciOiJIUzI1NiJ9.e30.${id}`;
    const repo = {
      getAccount: vi.fn(async (id: string) => getAccount(id)),
      getFreshTokens: vi.fn(async (id: string) => ({ accessToken: tokenFor(id), idToken: tokenFor(id) })),
      updateQuota: vi.fn(async (id: string) => getAccount(id)),
      refreshSubscriptionState: vi.fn(async () => undefined)
    } as unknown as DashboardActionContext["repo"];
    fetchWithTimeoutMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const authorization = new Headers(init.headers).get("Authorization");
      if (authorization === `Bearer ${tokenFor("batch-healthy")}`) {
        return Response.json({ rate_limit: { primary_window: { used_percent: 25 } } });
      }
      if (authorization === `Bearer ${tokenFor("batch-rejected")}`) {
        return Response.json({ detail: { code: "permission_denied" } }, { status: 403 });
      }
      throw new Error(`Unexpected request for ${authorization}`);
    });
    const schedulePublishState = vi.fn();
    vi.mocked(vscode.window.showWarningMessage).mockClear();

    const result = await executeDashboardActionMessage(
      {
        context: {} as DashboardActionContext["context"],
        repo,
        resolveLanguage: () => "en",
        schedulePublishState,
        publishState: vi.fn(),
        oauth: {} as DashboardActionContext["oauth"],
        announcements: {} as DashboardActionContext["announcements"],
        getAnnouncementOptions: () => ({ version: "0.1.15", locale: "en" })
      },
      {
        type: "dashboard:action",
        action: "batchRefresh",
        requestId: "req-3",
        payload: { accountIds: ["batch-healthy", "batch-rejected", "batch-removed"] }
      }
    );

    expect(result.status).toBe("completed");
    expect(result.payload?.batchResult).toEqual({
      kind: "batch_refresh",
      successCount: 1,
      failedCount: 2,
      failures: [
        {
          accountId: "batch-rejected",
          email: "rejected@example.com",
          message: expect.stringContaining("API returned 403 [error_code:permission_denied]")
        },
        { accountId: "batch-removed", message: expect.stringContaining("batch-removed") }
      ]
    });
    expect(schedulePublishState).toHaveBeenCalledTimes(1);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith("Refreshed 1 selected account(s); 2 failed.");
  });
});
