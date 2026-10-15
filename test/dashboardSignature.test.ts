import { describe, expect, it } from "vitest";
import { buildDashboardStateSignature } from "../src/presentation/dashboard/signature";
import type { DashboardState } from "../src/domain/dashboard/types";

function createState(overrides?: {
  resetCreditsAvailable?: number;
  resetCreditsNextExpiresAt?: number;
}): DashboardState {
  return {
    lang: "zh",
    panelTitle: "title",
    brandSub: "sub",
    logoUri: "logo",
    settings: {
      dashboardTheme: "dark",
      displayLanguage: "zh",
      autoRefreshMinutes: 0,
      backgroundTokenRefreshEnabled: true,
      autoSwitchEnabled: false,
      hourlyQuotaControlEnabled: false,
      autoSwitchReloadWindowEnabled: false,
      autoSwitchHourlyThreshold: 20,
      autoSwitchWeeklyThreshold: 20,
      autoSwitchLockMinutes: 0,
      quotaWarningEnabled: false,
      quotaWarningThreshold: 20,
      quotaGreenThreshold: 60,
      quotaYellowThreshold: 20,
      codexAppRestartEnabled: false,
      codexAppRestartMode: "manual",
      codexAppPath: "",
      resolvedCodexAppPath: ""
    },
    copy: {} as DashboardState["copy"],
    tokenAutomation: {
      enabled: true
    },
    announcements: {
      announcements: [],
      unreadIds: []
    },
    indexHealth: {
      status: "healthy",
      availableBackups: 0
    },
    accounts: [
      {
        id: "account-1",
        email: "dev@example.com",
        displayName: "dev@example.com",
        tags: [],
        planTypeLabel: "Plus",
        isActive: true,
        showInStatusBar: false,
        healthKind: "healthy",
        dismissedHealth: false,
        metrics: [],
        resetCreditsAvailable: overrides?.resetCreditsAvailable,
        resetCreditsNextExpiresAt: overrides?.resetCreditsNextExpiresAt
      } as DashboardState["accounts"][number]
    ]
  };
}

describe("buildDashboardStateSignature", () => {
  it("publishes wakeup changes even when accounts have not changed", () => {
    const state = createState();
    state.wakeup = {
      version: 4,
      timeZone: "Asia/Shanghai",
      tasks: [
        {
          id: "task-1",
          name: "Morning",
          enabled: false,
          accountIds: ["account-1"],
          time: "06:15",
          days: [0, 1, 2, 3, 4, 5, 6],
          model: "gpt-5.6-luna",
          effort: "low",
          prompt: "Reply with OK.",
          createdAt: 1,
          updatedAt: 1,
          nextRunAt: 2
        }
      ],
      history: []
    };
    const before = buildDashboardStateSignature(state);
    state.wakeup.tasks[0]!.enabled = true;
    expect(buildDashboardStateSignature(state)).not.toBe(before);
  });
  it("changes when reset credits expiry changes", () => {
    const before = buildDashboardStateSignature(createState({ resetCreditsAvailable: 1 }));
    const after = buildDashboardStateSignature(
      createState({ resetCreditsAvailable: 1, resetCreditsNextExpiresAt: 1_800_000_000 })
    );

    expect(after).not.toBe(before);
  });

  it("changes when visible subscription or workspace fields change", () => {
    const beforeState = createState();
    const afterState = createState();
    afterState.accounts[0]!.subscriptionText = "2026-12-31 (90d)";
    afterState.accounts[0]!.workspaceLabel = "Workspace | Platform";

    expect(buildDashboardStateSignature(afterState)).not.toBe(buildDashboardStateSignature(beforeState));
  });
});
