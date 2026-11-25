import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithTimeoutMock } = vi.hoisted(() => ({
  fetchWithTimeoutMock: vi.fn()
}));

vi.mock("../src/utils/debug", () => ({
  logNetworkEvent: vi.fn()
}));

vi.mock("../src/utils/network", () => ({
  fetchWithTimeout: fetchWithTimeoutMock
}));

import { fetchSubscriptionStatus, shouldAttemptSubscriptionRefresh } from "../src/services/subscription";

describe("subscription service", () => {
  beforeEach(() => {
    fetchWithTimeoutMock.mockReset();
  });

  it("queries the complete account list and selects the requested workspace expiry", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          accounts: {
            personal: {
              account: { account_id: "acct_plus", plan_type: "plus", expires_at: "1900000000" }
            },
            team: {
              account: { account_id: "acct_team", plan_type: "team", expires_at: "1950000000" }
            }
          },
          account_ordering: ["personal", "team"]
        }),
        { status: 200 }
      )
    );
    fetchWithTimeoutMock.mockResolvedValueOnce(new Response(null, { status: 403 }));

    const snapshot = await fetchSubscriptionStatus("access-token", "acct_team");

    expect(snapshot).toMatchObject({
      accountId: "acct_team",
      planType: "team",
      subscriptionActiveUntil: "1950000000"
    });
    const [, init] = fetchWithTimeoutMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).has("ChatGPT-Account-Id")).toBe(false);
  });

  it("uses the requested workspace's confirmed past expiry over a future entitlement", async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        accounts: { target: { account: { account_id: "acct_target", plan_type: "team" },
          entitlement: { subscription_plan: "team", expires_at: "2099-01-01T00:00:00Z" } } }
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        subscription_plan: "team", active_until: "invalid", expires_at: "2020-01-01T00:00:00Z"
      })));

    const snapshot = await fetchSubscriptionStatus("access-token", "acct_target");

    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
    const detailUrl = fetchWithTimeoutMock.mock.calls[1]?.[0] as string;
    expect(new URL(detailUrl).searchParams.get("account_id")).toBe("acct_target");
    expect(snapshot).toMatchObject({
      source: "subscription", accountId: "acct_target", subscriptionActiveUntil: "2020-01-01T00:00:00Z"
    });
    expect(snapshot.planType).toBeUndefined();
  });

  it.each([new Response(null, { status: 403 }), new Response(JSON.stringify({ active_until: "invalid" }))])(
    "keeps the current matched entitlement when subscription details are unavailable or invalid",
    async (details) => {
      fetchWithTimeoutMock
        .mockResolvedValueOnce(new Response(JSON.stringify({
          accounts: [{ account_id: "acct_target", plan_type: "team", expires_at: "2099-01-01T00:00:00Z" }]
        })))
        .mockResolvedValueOnce(details);

      expect(await fetchSubscriptionStatus("access-token", "acct_target")).toMatchObject({
        source: "entitlement", planType: "team", subscriptionActiveUntil: "2099-01-01T00:00:00Z"
      });
      expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
    }
  );

  it("does not use the default workspace when the known workspace is missing", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(new Response(JSON.stringify({
      accounts: { default: { account: { account_id: "acct_other", plan_type: "plus" },
        entitlement: { expires_at: "2099-01-01T00:00:00Z" } } },
      account_ordering: ["default"]
    })));

    expect(await fetchSubscriptionStatus("access-token", "acct_target")).toEqual({
      source: "unconfirmed", accountId: "acct_target"
    });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it("does not use a different explicit account ID within the same organization", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(Response.json({
      accounts: [{ account_id: "acct_other", organization_id: "org_business", plan_type: "business", expires_at: "2099-01-01T00:00:00Z" }]
    }));

    expect(await fetchSubscriptionStatus("access-token", "acct_target", "org_business")).toEqual({
      source: "unconfirmed", accountId: "acct_target"
    });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it("skips paid details for a confirmed Free workspace", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(new Response(JSON.stringify({
      accounts: [{ account_id: "acct_free", plan_type: "free", structure: "personal",
        entitlement: { subscription_plan: "plus", expires_at: "2020-01-01T00:00:00Z" } }]
    })));

    expect(await fetchSubscriptionStatus("access-token", "acct_free")).toEqual({
      source: "confirmed-free", accountId: "acct_free", planType: "free"
    });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it("allows a forced refresh even when the cached expiry is still valid", () => {
    expect(
      shouldAttemptSubscriptionRefresh(
        {
          id: "team-account",
          email: "dev@example.com",
          subscriptionActiveUntil: "1950000000",
          createdAt: 1,
          updatedAt: 1
        },
        true
      )
    ).toBe(true);
  });

  it("rechecks an unclassified legacy date and backs off unsuccessful confirmation", () => {
    const account = {
      id: "team-account", email: "dev@example.com", planType: "team", createdAt: 1, updatedAt: 1,
      subscriptionActiveUntil: "2099-01-01T00:00:00Z"
    };
    expect(shouldAttemptSubscriptionRefresh(account, false)).toBe(true);
    expect(shouldAttemptSubscriptionRefresh({ ...account, subscriptionExpirySource: "subscription" }, false)).toBe(false);
    const unconfirmed = { ...account, subscriptionExpirySource: "subscription" as const, subscriptionQueryLastError: "Unavailable" };
    expect(shouldAttemptSubscriptionRefresh({ ...unconfirmed, subscriptionQueryNextRetryAt: Date.now() + 60_000 }, false)).toBe(false);
    expect(shouldAttemptSubscriptionRefresh({ ...unconfirmed, subscriptionQueryNextRetryAt: Date.now() - 1 }, false)).toBe(true);
    expect(shouldAttemptSubscriptionRefresh({ ...account, planType: "free", subscriptionExpirySource: "confirmed-free" }, false)).toBe(false);
  });

  it("disambiguates Plus and Team workspaces that share the same accountId", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          accounts: {
            personal: {
              account: {
                account_id: "acct_shared",
                organization_id: "org_personal",
                plan_type: "plus"
              },
              entitlement: { subscription_plan: "plus", expires_at: "1900000000" }
            },
            team: {
              account: {
                account_id: "acct_shared",
                organization_id: "org_team",
                plan_type: "chatgptteamplan"
              },
              entitlement: { subscription_plan: "chatgptteamplan", expires_at: "1950000000" }
            }
          },
          account_ordering: ["personal", "team"]
        }),
        { status: 200 }
      )
    );

    fetchWithTimeoutMock.mockResolvedValueOnce(new Response(JSON.stringify({
      account_id: "acct_shared", organization_id: "org_personal", active_until: "2099-01-01T00:00:00Z"
    })));

    const snapshot = await fetchSubscriptionStatus("access-token", "acct_shared", "org_team");

    expect(snapshot).toMatchObject({
      source: "entitlement",
      accountId: "acct_shared",
      planType: "chatgptteamplan",
      subscriptionActiveUntil: "1950000000"
    });
  });

  it("uses the saved workspace structure when shared accountId records have no organizationId", async () => {
    const payload = {
      accounts: {
        team: {
          account: { account_id: "acct_shared", name: "leixiaoan", structure: "workspace" },
          entitlement: { subscription_plan: "chatgptteamplan", expires_at: "1950000000" }
        },
        personal: {
          account: { account_id: "acct_personal", name: null, structure: "personal" },
          entitlement: { subscription_plan: "plus", expires_at: "1900000000" }
        }
      },
      account_ordering: ["team", "personal"]
    };
    fetchWithTimeoutMock
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));

    const personal = await fetchSubscriptionStatus("personal-token", "acct_shared", undefined, "Personal", "personal");
    const team = await fetchSubscriptionStatus("team-token", "acct_shared", undefined, "leixiaoan", "workspace");

    expect(personal).toMatchObject({
      accountId: "acct_personal",
      planType: "plus",
      subscriptionActiveUntil: "1900000000"
    });
    expect(team).toMatchObject({ planType: "chatgptteamplan", subscriptionActiveUntil: "1950000000" });
  });

  it("keeps the historical expiry without returning the expired paid plan", async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accounts: {
              personal: {
                account: { account_id: "acct_free", structure: "personal" },
                entitlement: { subscription_plan: "pro", expires_at: "1000000000" }
              }
            }
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ subscription_plan: "pro", active_until: "1000000000" }), { status: 200 })
      );

    const snapshot = await fetchSubscriptionStatus("free-token", "acct_free", undefined, "Personal", "personal");

    expect(snapshot).toMatchObject({ source: "subscription", accountId: "acct_free", subscriptionActiveUntil: "1000000000" });
    expect(snapshot.planType).toBeUndefined();
  });
});
