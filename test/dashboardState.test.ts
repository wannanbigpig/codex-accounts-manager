import { describe, expect, it } from "vitest";
import {
  buildMetrics,
  formatCreditsText,
  resolveWorkspaceDisplay,
  sortDashboardAccounts
} from "../src/application/dashboard/buildDashboardState";
import { formatPlanType, getDashboardCopy } from "../src/application/dashboard/copy";

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
    ).toBe("剩余额度: 0 / 25000");
  });
});
