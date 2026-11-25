import { describe, expect, it } from "vitest";
import {
  buildDashboardState,
  buildMetrics,
  formatCreditsText,
  resolveSubscriptionDisplay,
  resolveWorkspaceDisplay,
  sortDashboardAccounts
} from "../src/application/dashboard/buildDashboardState";
import { formatAccountPlan, formatPlanType, getDashboardCopy } from "../src/application/dashboard/copy";
import { ExtensionSettingsStore } from "../src/infrastructure/config/extensionSettings";
import { buildDashboardStateSignature } from "../src/presentation/dashboard/signature";
import { buildWorkbenchRefreshSignature } from "../src/presentation/workbench/refreshSignature";
import { normalizeQuotaSummary } from "../src/utils/quotaWindows";

const account = { id: "example", email: "dev@example.com", isActive: true, createdAt: 1, updatedAt: 1 };

describe("buildDashboardState", () => {
  it("publishes a 429 retry deadline only on the affected workspace and includes changes in the signature", async () => {
    const retryAt = 4_073_000_000_000;
    const accounts = [
      { ...account, id: "business", accountId: "shared", organizationId: "org",
        quotaError: { statusCode: 429, message: "Limited", timestamp: 1, retryAt } },
      { ...account, id: "personal", accountId: "shared", isActive: false }
    ];
    const build = () => buildDashboardState({
      listAccounts: async () => accounts,
      getDashboardAccountOrder: async () => [],
      getIndexHealthSummary: async () => ({ status: "healthy" as const, availableBackups: 0 }),
      getTokens: async () => undefined
    } as Parameters<typeof buildDashboardState>[0], new ExtensionSettingsStore(), "", { announcements: [], unreadIds: [] });
    const state = await build();
    expect(state.accounts.find((item) => item.id === "business")).toMatchObject({ quotaHttpStatus: 429, quotaRetryAt: retryAt });
    expect(state.accounts.find((item) => item.id === "personal")?.quotaRetryAt).toBeUndefined();
    accounts[0]!.quotaError!.retryAt += 60_000;
    expect(buildDashboardStateSignature(await build())).not.toBe(buildDashboardStateSignature(state));
  });

  it.each([0, undefined])("exposes the pending reset separately from credit balance %s", async (resetCreditsAvailable) => {
    const requestId = "2fb693e4-2292-45f0-afc0-b69f73d527c8";
    const savedAccount = {
      ...account,
      accountId: "acct_fixture",
      quotaSummary: { hourlyPercentage: 20, weeklyPercentage: 80, resetCreditsAvailable }
    };
    const pendingAccount = {
      ...savedAccount,
      resetCreditRedemption: { requestId, pending: true, accountId: savedAccount.accountId }
    };
    const indexHealth = { status: "healthy" as const, availableBackups: 0 };
    const buildState = (saved: typeof savedAccount) =>
      buildDashboardState(
        {
          listAccounts: async () => [saved],
          getDashboardAccountOrder: async () => [],
          getIndexHealthSummary: async () => indexHealth,
          getTokens: async () => undefined
        } as Parameters<typeof buildDashboardState>[0],
        new ExtensionSettingsStore(),
        "",
        { announcements: [], unreadIds: [] }
      );

    const [before, pending] = await Promise.all([buildState(savedAccount), buildState(pendingAccount)]);

    expect(before.accounts[0]?.resetRedemptionPending).toBeFalsy();
    expect(pending.accounts[0]?.resetRedemptionPending).toBe(true);
    expect(pending.accounts[0]?.resetCreditsAvailable).toBe(resetCreditsAvailable);
    expect(JSON.stringify(pending)).not.toContain(requestId);
    expect(buildDashboardStateSignature(pending)).not.toBe(buildDashboardStateSignature(before));
    expect(buildWorkbenchRefreshSignature({ accounts: [pendingAccount], indexHealth })).not.toBe(
      buildWorkbenchRefreshSignature({ accounts: [savedAccount], indexHealth })
    );
  });
});

describe("sortDashboardAccounts", () => {
  it("puts the current window account before active accounts", () => {
    const accounts = [
      { id: "active", isActive: true, createdAt: 3, email: "active@example.com" },
      { id: "current", isActive: false, createdAt: 2, email: "current@example.com" },
      { id: "other", isActive: false, createdAt: 1, email: "other@example.com" }
    ];

    const sorted = sortDashboardAccounts(accounts, "current");

    expect(sorted.map((account) => account.id)).toEqual(["current", "active", "other"]);
  });
});

describe("formatPlanType", () => {
  it("normalizes raw ChatGPT plan identifiers", () => {
    expect(formatPlanType("chatgptteamplan", "zh")).toBe("Business");
    expect(formatPlanType("chatgptbusinessplan", "zh")).toBe("Business");
    expect(formatPlanType("chatgptplusplan", "zh")).toBe("Plus");
  });
});

describe("formatAccountPlan", () => {
  const quota = { hourlyPercentage: 90, weeklyPercentage: 80, codeReviewPercentage: 70 };

  it("uses explicit plan identifiers and ignores unrelated quota strings", () => {
    expect(
      formatAccountPlan({ planType: "pro-5x", quotaSummary: { ...quota, rawData: { plan_type: "pro-20x" } } }, "en")
    ).toBe("Pro 5x");
    expect(formatAccountPlan({ planType: "pro", quotaSummary: { ...quota, rawData: { other: "20x" } } }, "en")).toBe("Pro");
    expect(
      formatAccountPlan({ planType: "pro", quotaSummary: { ...quota, rawData: { plan_type: "chatgptpromax" } } }, "en")
    ).toBe("Pro 500");
    expect(formatAccountPlan({ planType: "prolite" }, "en")).toBe("Pro 100");
    expect(
      formatAccountPlan({ planType: "free", quotaSummary: { ...quota, rawData: { plan_type: "pro-20x" } } }, "en")
    ).toBe("Free");
  });
});

describe("resolveSubscriptionDisplay", () => {
  const copy = getDashboardCopy("zh");

  it("does not restore a paid expiry from a JWT after Free is confirmed", () => {
    const payload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_subscription_active_until: "2099-01-02T00:00:00Z" } })
    ).toString("base64url");
    const tokens = { idToken: `header.${payload}.signature`, accessToken: "access" };

    expect(
      resolveSubscriptionDisplay({ ...account, planType: "free", subscriptionExpirySource: "confirmed-free" }, tokens, copy, "zh")
    ).toMatchObject({ text: "—", title: "无付费订阅" });
  });

  it("distinguishes a retained unconfirmed date from a confirmed expired date", () => {
    const expired = { ...account, subscriptionExpirySource: "subscription" as const, subscriptionActiveUntil: "2000-01-02T12:00:00" };
    const unconfirmed = resolveSubscriptionDisplay({ ...expired, subscriptionQueryLastError: "failed" }, undefined, copy, "zh");
    const confirmed = resolveSubscriptionDisplay(expired, undefined, copy, "zh");

    expect(unconfirmed.text).toMatch(/2000-01-02.*待确认/);
    expect(unconfirmed.color).toBeUndefined();
    expect(confirmed.text).toMatch(/2000-01-02.*已过期/);
    expect(confirmed.text).not.toContain("0 天");
  });
});

describe("resolveWorkspaceDisplay", () => {
  it("uses a neutral Workspace label instead of treating every collaborative space as Team", () => {
    expect(
      resolveWorkspaceDisplay({
        id: "workspace-account",
        email: "dev@example.com",
        accountName: "Platform",
        accountStructure: "organization",
        isActive: false,
        createdAt: 1,
        updatedAt: 1
      })
    ).toBe("Workspace | Platform");
  });
});

describe("buildMetrics", () => {
  it("labels a Free 30-day quota as monthly", () => {
    const metrics = buildMetrics(
      {
        id: "free-account",
        email: "free@example.com",
        isActive: true,
        planType: "chatgptfreeplan",
        createdAt: 1,
        updatedAt: 1,
        quotaSummary: {
          hourlyPercentage: 0,
          weeklyPercentage: 1,
          weeklyWindowMinutes: 43_200,
          weeklyWindowPresent: true
        }
      },
      getDashboardCopy("zh"),
      "zh"
    );

    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.label).toBe("每月");
  });

  it("shows Code Review only when the API reports that window", () => {
    const metrics = buildMetrics(
      {
        id: "business-account",
        email: "business@example.com",
        isActive: true,
        planType: "business",
        createdAt: 1,
        updatedAt: 1,
        quotaSummary: {
          hourlyPercentage: 90,
          hourlyWindowPresent: true,
          weeklyPercentage: 80,
          weeklyWindowPresent: true,
          codeReviewPercentage: 65,
          codeReviewResetTime: 1_800_000_000,
          codeReviewWindowPresent: true
        }
      },
      getDashboardCopy("zh"),
      "zh"
    );

    expect(metrics).toContainEqual(
      expect.objectContaining({ key: "code-review", label: "代码审查", percentage: 65, visible: true })
    );
  });
});

describe("formatCreditsText", () => {
  it("displays zero for saved usage that explicitly reports no credits", () => {
    const quota = normalizeQuotaSummary({
      hourlyPercentage: 0,
      weeklyPercentage: 88,
      codeReviewPercentage: 0,
      credits: {
        availability: "unknown", balance: "", hasCredits: false, unlimited: false,
        overageLimitReached: false, approxCloudMessages: [], approxLocalMessages: []
      },
      rawData: { credits: { has_credits: false, balance: null }, spend_control: { individual_limit: null } }
    }, "workspace");

    expect(formatCreditsText(quota?.credits, "zh")).toBe("剩余积分: 0");
  });

  it.each([
    ["available", "", "Credits left: Available, balance undisclosed"],
    ["exhausted", "0", "Credits left: 0"],
    ["unknown", "", "Credits left: Unknown"],
    ["limited", "8", "Credits left: Limit reached"]
  ] as const)("renders %s credits independently of the numeric balance", (availability, balance, text) => {
    expect(formatCreditsText({
      availability, balance, unlimited: false, hasCredits: availability === "available",
      overageLimitReached: availability === "limited", approxCloudMessages: [], approxLocalMessages: []
    }, "en")).toBe(text);
  });

  it("shows remaining and total monthly Business credits, including zero", () => {
    expect(
      formatCreditsText(
        {
          hasCredits: false,
          unlimited: false,
          overageLimitReached: true,
          balance: "0",
          remaining: 0,
          total: 25000,
          approxLocalMessages: [],
          approxCloudMessages: []
        },
        "zh"
      )
    ).toBe("剩余积分: 0 / 25000");
  });
});
