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
});

describe("consumeResetCredit", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the caller-provided idempotency id when consuming a reset credit", async () => {
    const fetchMock = vi.fn(async () => new Response('{"code":"reset"}'));
    vi.stubGlobal("fetch", fetchMock);

    await expect(consumeResetCredit("token", "acct-4", "fixed-request-id")).resolves.toBe("reset");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("ChatGPT-Account-Id")).toBe("acct-4");
    expect(JSON.parse(String(init.body))).toEqual({ redeem_request_id: "fixed-request-id" });
  });

  it("includes the selected credit ID in the redemption request", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ code: "reset" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(consumeResetCredit("token", "acct-4", "fixed-request-id", "second-credit")).resolves.toBe("reset");

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1].body))).toEqual({
      redeem_request_id: "fixed-request-id", credit_id: "second-credit"
    });
  });

  it.each(["already_redeemed", "nothing_to_reset", "no_credit"])("returns business code %s from a successful HTTP response", async (code) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code }))));

    await expect(consumeResetCredit("token", "acct-4", "fixed-request-id")).resolves.toBe(code);
  });

  it.each([
    ["missing code", "{}", 200],
    ["unknown code", '{"code":"pending"}', 200],
    ["malformed JSON", "{", 200],
    ["empty success", null, 204]
  ])("reports an unconfirmed outcome for %s", async (_label, body, status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));

    await expect(consumeResetCredit("token", "acct-4", "fixed-request-id")).rejects.toMatchObject({
      name: "APIError",
      statusCode: status,
      context: expect.objectContaining({ errorCode: "reset_credit_outcome_unconfirmed" })
    });
  });

  it("preserves the HTTP error without treating its body as a redemption result", async () => {
    const body = '{"code":"reset","detail":{"code":"token_expired"}}';
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 401 })));

    await expect(consumeResetCredit("token", "acct-4", "fixed-request-id")).rejects.toMatchObject({
      name: "APIError", statusCode: 401, responseBody: body, context: { errorCode: "token_expired" }
    });
  });
});
