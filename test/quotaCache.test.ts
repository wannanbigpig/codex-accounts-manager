import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAccountRecord, CodexTokens } from "../src/core/types";

const { fetchWithTimeoutMock } = vi.hoisted(() => ({
  fetchWithTimeoutMock: vi.fn()
}));

vi.mock("../src/auth/oauth", () => ({
  needsRefresh: vi.fn(() => false),
  needsTokenRefresh: vi.fn(() => false),
  refreshTokens: vi.fn()
}));

vi.mock("../src/utils/debug", () => ({
  logNetworkEvent: vi.fn()
}));

vi.mock("../src/utils/network", () => ({
  fetchWithTimeout: fetchWithTimeoutMock,
  isRetriableHttpStatus: vi.fn(() => false),
  isRetriableNetworkError: vi.fn(() => false),
  retryWithBackoff: async <T>(operation: () => Promise<T>) => operation()
}));

import { clearQuotaCacheForAccount, refreshQuota } from "../src/services/quota";

function createDeferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createUsageResponse(usedPercent: number, identity: Record<string, string> = {}): Response {
  return new Response(
    JSON.stringify({
      ...identity,
      rate_limit: {
        primary_window: {
          used_percent: usedPercent,
          reset_after_seconds: 300,
          limit_window_seconds: 18_000
        }
      }
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    }
  );
}

describe("quota cache invalidation", () => {
  const account: CodexAccountRecord = {
    id: "account-1",
    email: "dev@example.com",
    accountId: "acct_123",
    isActive: false,
    createdAt: 1,
    updatedAt: 1
  };
  const tokens: CodexTokens = {
    idToken: "id-token",
    accessToken: "access-token",
    accountId: "acct_123"
  };

  beforeEach(() => {
    fetchWithTimeoutMock.mockReset();
    clearQuotaCacheForAccount(account.id);
  });

  it.each([
    { account_id: "acct_personal", user_id: "user_1" },
    { account_id: "acct_123", user_id: "user_other" },
    { account_id: "acct_123", organization_id: "org_other" }
  ])("rejects a usage response with conflicting workspace identity: %j", async (identity) => {
    const business = { ...account, userId: "user_1", organizationId: "org_business" };
    fetchWithTimeoutMock.mockResolvedValueOnce(createUsageResponse(10, identity as Record<string, string>));

    const result = await refreshQuota(business, tokens);

    expect(result.quota).toBeUndefined();
    expect(result.error?.code).toBe("workspace_identity_mismatch");
    fetchWithTimeoutMock.mockResolvedValueOnce(createUsageResponse(20));
    expect((await refreshQuota(business, tokens)).quota?.hourlyPercentage).toBe(80);
  });

  it.each([
    { identity: {}, expected: undefined },
    { identity: { account_id: "acct_123", user_id: "user_1" }, expected: undefined },
    { identity: { account_id: "acct_123", organization_id: "org_business" }, expected: 80 }
  ])("only accepts a verified workspace from the unscoped retry: %j", async ({ identity, expected }) => {
    const business = { ...account, userId: "user_1", organizationId: "org_business" };
    fetchWithTimeoutMock
      .mockResolvedValueOnce(new Response('{"detail":{"code":"workspace_not_found"}}', { status: 404 }))
      .mockResolvedValueOnce(createUsageResponse(20, identity as Record<string, string>));

    const result = await refreshQuota(business, tokens);

    expect(fetchWithTimeoutMock.mock.calls[0]?.[1].headers.get("ChatGPT-Account-Id")).toBe("acct_123");
    expect(fetchWithTimeoutMock.mock.calls[1]?.[1].headers.get("ChatGPT-Account-Id")).toBeNull();
    expect(result.quota?.hourlyPercentage).toBe(expected);
    if (expected === undefined) {
      expect(result.error?.code).toBe("workspace_identity_mismatch");
    }
  });

  it("keeps the deactivated workspace error without trying a different workspace", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response('{"detail":{"code":"deactivated_workspace"}}', { status: 402 })
    );

    expect((await refreshQuota(account, tokens)).error?.code).toBe("deactivated_workspace");
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it("rejects Business quota on an unscoped retry for Personal when the account ID is shared", async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce(new Response('{"detail":{"code":"workspace_not_found"}}', { status: 404 }))
      .mockResolvedValueOnce(createUsageResponse(60, { account_id: "acct_123", user_id: "user_1", plan_type: "business" }));

    const personal = { ...account, accountStructure: "personal", userId: "user_1" };
    const result = await refreshQuota(personal, tokens);

    expect(result.error?.code).toBe("workspace_identity_mismatch");
    expect(result.quota).toBeUndefined();
  });

  it("does not reuse an inflight or cached quota for a previous workspace on the same saved record", async () => {
    const firstRequest = createDeferredResponse();
    fetchWithTimeoutMock.mockImplementationOnce(() => firstRequest.promise);
    const previous = refreshQuota(account, tokens);
    const corrected = { ...account, accountId: "acct_personal" };
    fetchWithTimeoutMock.mockResolvedValueOnce(createUsageResponse(20, { account_id: "acct_personal" }));
    const latest = refreshQuota(corrected, tokens);
    firstRequest.resolve(createUsageResponse(10, { account_id: "acct_123" }));

    expect((await previous).quota?.hourlyPercentage).toBe(90);
    expect(await latest).toMatchObject({ quota: { hourlyPercentage: 80 }, observedAt: expect.any(Number) });
    expect(await refreshQuota(corrected, tokens)).toEqual({ quota: expect.objectContaining({ hourlyPercentage: 80 }) });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a refreshed credential separate from the old request for the same workspace", async () => {
    const firstRequest = createDeferredResponse();
    fetchWithTimeoutMock.mockImplementationOnce(() => firstRequest.promise);
    const previous = refreshQuota(account, tokens);
    const newTokens = { ...tokens, accessToken: "refreshed-access-token" };
    fetchWithTimeoutMock.mockResolvedValueOnce(createUsageResponse(20));
    const latest = refreshQuota(account, newTokens);
    firstRequest.resolve(createUsageResponse(10));

    expect((await previous).updatedTokens).toEqual(tokens);
    expect((await latest).updatedTokens).toEqual(newTokens);
    expect((await refreshQuota(account, newTokens)).quota?.hourlyPercentage).toBe(80);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it("does not repopulate cache from an invalidated inflight refresh", async () => {
    const firstRequest = createDeferredResponse();
    fetchWithTimeoutMock.mockImplementationOnce(() => firstRequest.promise);

    const inflightRefresh = refreshQuota(account, tokens, true);
    clearQuotaCacheForAccount(account.id);

    firstRequest.resolve(createUsageResponse(10));
    const firstResult = await inflightRefresh;
    expect(firstResult.quota?.hourlyPercentage).toBe(90);

    fetchWithTimeoutMock.mockResolvedValueOnce(createUsageResponse(20));
    const secondResult = await refreshQuota(account, tokens);

    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
    expect(secondResult.quota?.hourlyPercentage).toBe(80);
  });

  it("interprets fractional used_percent values as ratios", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: {
              used_percent: 0.25,
              reset_after_seconds: 300,
              limit_window_seconds: 18_000
            },
            secondary_window: {
              used_percent: 0.5,
              reset_after_seconds: 600,
              limit_window_seconds: 604_800
            }
          }
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
    );

    const result = await refreshQuota(account, tokens, true);

    expect(result.quota?.hourlyPercentage).toBe(75);
    expect(result.quota?.weeklyPercentage).toBe(50);
  });

  it("treats used_percent equal to one as one percent instead of a full ratio", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: {
              used_percent: 1,
              reset_after_seconds: 300,
              limit_window_seconds: 18_000
            },
            secondary_window: {
              used_percent: 0,
              reset_after_seconds: 600,
              limit_window_seconds: 604_800
            }
          }
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
    );

    const result = await refreshQuota(account, tokens, true);

    expect(result.quota?.hourlyPercentage).toBe(99);
    expect(result.quota?.weeklyPercentage).toBe(100);
  });

  it("keeps an absent short window unknown when a weekly window is valid", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: {
              reset_after_seconds: 300,
              limit_window_seconds: 18_000
            },
            secondary_window: { used_percent: 100, limit_window_seconds: 604_800 }
          }
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
    );

    const result = await refreshQuota(account, tokens, true);

    expect(result.quota?.hourlyWindowPresent).toBe(false);
    expect(result.quota?.hourlyPercentage).toBe(0);
    expect(result.quota?.weeklyWindowPresent).toBe(true);
    expect(result.quota?.weeklyPercentage).toBe(0);
  });

  it("uses a valid secondary Code Review window when the primary window has no usage", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: {
              used_percent: 10,
              reset_after_seconds: 300,
              limit_window_seconds: 18_000
            }
          },
          code_review_rate_limit: {
            primary_window: {
              reset_after_seconds: 300,
              limit_window_seconds: 86_400
            },
            secondary_window: {
              used_percent: 30,
              reset_after_seconds: 900,
              limit_window_seconds: 86_400
            }
          }
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
    );

    const result = await refreshQuota(account, tokens, true);

    expect(result.quota?.codeReviewWindowPresent).toBe(true);
    expect(result.quota?.codeReviewPercentage).toBe(70);
    expect(result.quota?.codeReviewResetTime).toBeDefined();
  });

  it("parses camelCase and nested Code Review aliases", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: {
              used_percent: 10,
              limit_window_seconds: 18_000
            },
            codeReviewRateLimit: {
              primaryWindow: {
                remainingPercent: 55,
                resetAt: 1_800_000_000,
                limitWindowSeconds: 86_400,
                requestsLeft: 11,
                requestsLimit: 20
              }
            }
          }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await refreshQuota(account, tokens, true);

    expect(result.quota).toMatchObject({
      codeReviewPercentage: 55,
      codeReviewResetTime: 1_800_000_000,
      codeReviewRequestsLeft: 11,
      codeReviewRequestsLimit: 20,
      codeReviewWindowMinutes: 1440,
      codeReviewWindowPresent: true
    });
  });

  it("detects percentage scales independently for main and Code Review windows", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 10, limit_window_seconds: 18_000 }
          },
          code_review_rate_limit: {
            primary_window: { used_percent: 0.25, limit_window_seconds: 86_400 }
          }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await refreshQuota(account, tokens, true);

    expect(result.quota?.hourlyPercentage).toBe(90);
    expect(result.quota?.codeReviewPercentage).toBe(75);
  });

  it("rejects a malformed successful usage response", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response("not-json", { status: 200, headers: { "Content-Type": "application/json" } })
    );

    const result = await refreshQuota(account, tokens, true);

    expect(result.quota).toBeUndefined();
    expect(result.error?.message).toContain("Invalid quota response");
  });

  it("rejects an empty successful usage object", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
    );

    const result = await refreshQuota(account, tokens, true);

    expect(result.quota).toBeUndefined();
    expect(result.error?.message).toContain("Invalid quota response");
  });

  it.each([
    { rate_limit: {} },
    { rate_limit: { primary_window: { limit_window_seconds: 18_000 } } },
    { rate_limit: { primary_window: { used_percent: -1 } } },
    { rate_limit: { primary_window: { used_percent: 101 } } },
    { rate_limit: { primary_window: { used_percent: -1 }, secondary_window: { used_percent: 20 } }, credits: { has_credits: false } },
    { rate_limit: { primary_window: { remaining: 101, limit: 100 } } },
    { credits: {} },
    { rate_limit: {}, credits: { has_credits: false }, rate_limit_reset_credits: { available_count: 0 } },
    { additional_rate_limits: [{ limit_name: "Model", rate_limit: {} }] }
  ])("rejects and does not cache a 200 without valid measurements: %j", async (payload) => {
    fetchWithTimeoutMock.mockResolvedValueOnce(Response.json(payload)).mockResolvedValueOnce(createUsageResponse(100));
    expect(await refreshQuota(account, tokens)).toMatchObject({ error: { message: "Invalid quota response" } });
    expect((await refreshQuota(account, tokens)).quota).toMatchObject({ hourlyPercentage: 0, hourlyWindowPresent: true });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it("cannot turn a forced invalid refresh into cached success on the next read", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(createUsageResponse(15))
      .mockResolvedValueOnce(Response.json({ rate_limit: {} }))
      .mockResolvedValueOnce(createUsageResponse(30));
    expect((await refreshQuota(account, tokens)).quota?.hourlyPercentage).toBe(85);
    expect((await refreshQuota(account, tokens, true)).error).toBeDefined();
    expect((await refreshQuota(account, tokens)).quota?.hourlyPercentage).toBe(70);
  });

  it("recognizes no credits alongside a valid quota window", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(Response.json({
      rate_limit: { secondary_window: { used_percent: 12, limit_window_seconds: 604_800 } },
      credits: { has_credits: false, balance: null },
      spend_control: { individual_limit: null },
      rate_limit_reset_credits: { available_count: 3 }
    }));

    const result = await refreshQuota(account, tokens, true);
    expect(result.quota).toMatchObject({
      weeklyPercentage: 88,
      credits: { availability: "exhausted" },
      resetCreditsAvailable: 3
    });
  });

  it("keeps workspace credits separate even when Personal and Business share an email and account ID", async () => {
    const personal = { ...account, id: "personal-credits", accountStructure: "personal", organizationId: "org_personal" };
    const business = { ...account, id: "business-credits", accountStructure: "organization", organizationId: "org_business" };
    const ambient_usage = { default: { source: { kind: "credits" } } };
    fetchWithTimeoutMock
      .mockResolvedValueOnce(Response.json({ organization_id: "org_business", plan_type: "business", credits: {}, ambient_usage }))
      .mockResolvedValueOnce(Response.json({ organization_id: "org_personal", plan_type: "plus", credits: { balance: 0 }, ambient_usage }))
      .mockResolvedValueOnce(Response.json({ organization_id: "org_business", plan_type: "business", credits: { remaining: 8 }, spend_control: { reached: true } }));

    expect((await refreshQuota(business, tokens)).quota?.credits).toMatchObject({ availability: "available", balance: "" });
    expect((await refreshQuota(personal, tokens)).quota?.credits).toMatchObject({ availability: "exhausted", balance: "0" });
    expect((await refreshQuota(business, tokens)).quota?.credits).toMatchObject({ availability: "available", balance: "" });
    expect((await refreshQuota(business, tokens, true)).quota?.credits).toMatchObject({ availability: "limited" });
  });

  it("parses additional model quota from additional_rate_limits", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: {
              used_percent: 10,
              reset_after_seconds: 300,
              limit_window_seconds: 18_000
            },
            secondary_window: {
              used_percent: 20,
              reset_after_seconds: 900,
              limit_window_seconds: 604_800
            }
          },
          additional_rate_limits: [
            {
              limit_name: "GPT-5.3-Codex-Spark",
              metered_feature: "codex_bengalfox",
              rate_limit: {
                primary_window: {
                  used_percent: 0,
                  reset_at: 1_800_000_100,
                  limit_window_seconds: 18_000
                },
                secondary_window: {
                  used_percent: 10,
                  reset_at: 1_800_604_800,
                  limit_window_seconds: 604_800
                }
              }
            }
          ]
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
    );

    const result = await refreshQuota(account, tokens, true);
    const additional = result.quota?.additionalRateLimits?.[0];

    expect(additional?.limitName).toBe("GPT-5.3-Codex-Spark");
    expect(additional?.meteredFeature).toBe("codex_bengalfox");
    expect(additional?.hourlyPercentage).toBe(100);
    expect(additional?.hourlyResetTime).toBe(1_800_000_100);
    expect(additional?.weeklyPercentage).toBe(90);
    expect(additional?.weeklyResetTime).toBe(1_800_604_800);
  });

  it("parses Aideck-compatible quota aliases and request counts", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          rate_limit: {
            primaryWindow: {
              usedPercent: 25,
              resetAfterSeconds: 300,
              limitWindowSeconds: 18_000,
              requestsLeft: 75,
              requestsLimit: 100
            },
            secondaryWindow: {
              remainingPercent: 65,
              resetAt: 1_800_000_000,
              limitWindowSeconds: 604_800,
              remaining: 13,
              limit: 20
            }
          },
          additionalRateLimits: [
            {
              limitName: "GPT-5.3-Codex-Spark",
              meteredFeature: "codex_bengalfox",
              rateLimit: {
                primaryWindow: {
                  remainingPercent: 45,
                  resetTime: 1_800_000_300,
                  limitWindowSeconds: 18_000,
                  requestsLeft: 9,
                  requestsLimit: 20
                }
              }
            }
          ],
          credits: {
            has_credits: false,
            unlimited: false,
            overage_limit_reached: false,
            balance: "0"
          },
          subscription_active_until: 1_900_000_000
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
    );

    const result = await refreshQuota(account, tokens, true);

    expect(result.quota?.hourlyPercentage).toBe(75);
    expect(result.quota?.hourlyRequestsLeft).toBe(75);
    expect(result.quota?.hourlyRequestsLimit).toBe(100);
    expect(result.quota?.weeklyPercentage).toBe(65);
    expect(result.quota?.weeklyResetTime).toBe(1_800_000_000);
    expect(result.quota?.weeklyRequestsLeft).toBe(13);
    expect(result.quota?.weeklyRequestsLimit).toBe(20);
    expect(result.quota?.additionalRateLimits?.[0]).toMatchObject({
      limitName: "GPT-5.3-Codex-Spark",
      meteredFeature: "codex_bengalfox",
      hourlyPercentage: 45,
      hourlyResetTime: 1_800_000_300,
      hourlyRequestsLeft: 9,
      hourlyRequestsLimit: 20,
      hourlyWindowPresent: true
    });
    expect(result.quota?.credits?.balance).toBe("0");
    expect(result.updatedSubscriptionActiveUntil).toBe("1900000000");
  });

  it("parses Business monthly credits from spend_control", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 10, limit_window_seconds: 18_000 }
          },
          spend_control: {
            individual_limit: {
              limit: "25000",
              used: "8000",
              remaining: "17000",
              remaining_percent: 68,
              reset_at: 1_900_000_000
            }
          }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await refreshQuota(account, tokens, true);

    expect(result.quota?.credits).toMatchObject({
      balance: "17000",
      total: 25000,
      used: 8000,
      remaining: 17000,
      remainingPercent: 68,
      resetTime: 1_900_000_000
    });
  });
});
