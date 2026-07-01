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
  it("changes when reset credits expiry changes", () => {
    const before = buildDashboardStateSignature(createState({ resetCreditsAvailable: 1 }));
    const after = buildDashboardStateSignature(
      createState({ resetCreditsAvailable: 1, resetCreditsNextExpiresAt: 1_800_000_000 })
    );

    expect(after).not.toBe(before);
  });
});
