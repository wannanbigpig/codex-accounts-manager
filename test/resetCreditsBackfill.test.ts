import { describe, expect, it, vi, beforeEach } from "vitest";

const { fetchResetCreditsMock, logNetworkEventMock } = vi.hoisted(() => ({
  fetchResetCreditsMock: vi.fn(),
  logNetworkEventMock: vi.fn()
}));

vi.mock("../src/services/quota", async () => {
  const actual = await vi.importActual<typeof import("../src/services/quota")>("../src/services/quota");
  return {
    ...actual,
    fetchResetCredits: fetchResetCreditsMock
  };
});

vi.mock("../src/utils/debug", () => ({
  logNetworkEvent: logNetworkEventMock
}));

import { backfillMissingResetCreditExpiries, pickResetCreditsBackfillTargets } from "../src/presentation/dashboard/resetCreditsBackfill";

describe("resetCreditsBackfill", () => {
  beforeEach(() => {
    fetchResetCreditsMock.mockReset();
    logNetworkEventMock.mockReset();
  });

  it("picks accounts that have reset credits but no expiry yet", () => {
    const targets = pickResetCreditsBackfillTargets([
      { id: "a", resetCreditsAvailable: 1 } as never,
      { id: "b", resetCreditsAvailable: 1, resetCreditsNextExpiresAt: 1_800_000_000 } as never,
      { id: "c", resetCreditsAvailable: 0 } as never
    ]);

    expect(targets.map((account) => account.id)).toEqual(["a"]);
  });

  it("returns false when there is nothing to backfill", async () => {
    const repo = {
      getTokens: vi.fn(async () => ({ accessToken: "token" })),
      updateResetCreditsSnapshot: vi.fn(async () => undefined)
    };

    const updated = await backfillMissingResetCreditExpiries(
      repo as never,
      [{ id: "account-0", resetCreditsAvailable: 1, resetCreditsNextExpiresAt: 1_800_000_000 } as never],
      vi.fn(),
      1_700_000_000_000
    );

    expect(updated).toBe(false);
    expect(fetchResetCreditsMock).not.toHaveBeenCalled();
  });

  it("backfills missing expiry snapshots and schedules an update", async () => {
    fetchResetCreditsMock.mockResolvedValue({
      availableCount: 1,
      credits: [],
      nextExpiresAt: 1_800_000_000
    });
    const repo = {
      getTokens: vi.fn(async () => ({ accessToken: "token" })),
      updateResetCreditsSnapshot: vi.fn(async () => undefined)
    };
    const onUpdated = vi.fn();

    const updated = await backfillMissingResetCreditExpiries(
      repo as never,
      [{ id: "account-1", accountId: "acct-1", resetCreditsAvailable: 1 } as never],
      onUpdated,
      1_700_000_000_000
    );

    expect(fetchResetCreditsMock).toHaveBeenCalledWith("token", "acct-1");
    expect(logNetworkEventMock).toHaveBeenCalledWith(
      "resetCredits.backfill",
      expect.objectContaining({
        step: "fetched",
        availableCount: 1,
        nextExpiresAt: 1_800_000_000
      })
    );
    expect(repo.updateResetCreditsSnapshot).toHaveBeenCalledWith("account-1", 1, 1_800_000_000);
    expect(onUpdated).toHaveBeenCalled();
    expect(updated).toBe(true);
  });

  it("logs backfill failures instead of swallowing them silently", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchResetCreditsMock.mockRejectedValue(new Error("network down"));
    const repo = {
      getTokens: vi.fn(async () => ({ accessToken: "token" })),
      updateResetCreditsSnapshot: vi.fn(async () => undefined)
    };

    const updated = await backfillMissingResetCreditExpiries(
      repo as never,
      [{ id: "account-2", email: "dev@example.com", accountId: "acct-2", resetCreditsAvailable: 1 } as never],
      vi.fn(),
      1_700_000_000_000
    );

    expect(warnSpy).toHaveBeenCalledWith(
      "[codexAccounts] reset credits backfill failed for dev@example.com:",
      expect.any(Error)
    );
    expect(logNetworkEventMock).toHaveBeenCalledWith(
      "resetCredits.backfill",
      expect.objectContaining({
        step: "failed",
        error: "network down"
      })
    );
    expect(updated).toBe(false);

    warnSpy.mockRestore();
  });

  it("logs when the snapshot still has no expiry", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    fetchResetCreditsMock.mockResolvedValue({
      availableCount: 1,
      credits: [],
      nextExpiresAt: undefined
    });
    const repo = {
      getTokens: vi.fn(async () => ({ accessToken: "token" })),
      updateResetCreditsSnapshot: vi.fn(async () => undefined)
    };

    await backfillMissingResetCreditExpiries(
      repo as never,
      [{ id: "account-3", email: "dev@example.com", accountId: "acct-3", resetCreditsAvailable: 1 } as never],
      vi.fn(),
      1_700_000_000_000
    );

    expect(infoSpy).toHaveBeenCalledWith(
      "[codexAccounts] reset credits backfill returned 1 credit(s) without an expiry for dev@example.com"
    );

    infoSpy.mockRestore();
  });
});
