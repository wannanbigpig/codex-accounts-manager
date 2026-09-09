import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeResetCredit, fetchResetCredits } from "../src/services/quota";

describe("fetchResetCredits", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("prefers explicit next_expires_at from the reset credits payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            available_count: 1,
            next_expires_at: 1_800_000_123,
            credits: []
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        )
      )
    );

    const snapshot = await fetchResetCredits("token", "acct-1");

    expect(snapshot.availableCount).toBe(1);
    expect(snapshot.nextExpiresAt).toBe(1_800_000_123);
  });

  it("reads nested data.reset_credits_next_expires_at when present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: {
              available_count: 1,
              reset_credits_next_expires_at: "1800000456"
            }
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        )
      )
    );

    const snapshot = await fetchResetCredits("token", "acct-2");

    expect(snapshot.availableCount).toBe(1);
    expect(snapshot.nextExpiresAt).toBe(1_800_000_456);
  });

  it("derives next expiry from ISO expires_at values in available credits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            credits: [
              {
                id: "RateLimitResetCredit_1",
                status: "available",
                expires_at: "2026-07-26T23:49:56.470185Z"
              }
            ],
            available_count: 1
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        )
      )
    );

    const snapshot = await fetchResetCredits("token", "acct-3");

    expect(snapshot.availableCount).toBe(1);
    expect(snapshot.credits[0]?.expires_at).toBe(1_785_109_796);
    expect(snapshot.nextExpiresAt).toBe(1_785_109_796);
  });

  it("uses the caller-provided idempotency id when consuming a reset credit", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await consumeResetCredit("token", "acct-4", "fixed-request-id");

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ redeem_request_id: "fixed-request-id" });
  });
});
