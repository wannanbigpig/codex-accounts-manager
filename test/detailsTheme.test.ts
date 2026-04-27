import * as vscode from "vscode";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSubscriptionDisplay } from "../src/application/dashboard/buildDashboardState";
import { getDashboardCopy } from "../src/application/dashboard/copy";
import {
  getDetailsThemePreference,
  getDetailsWorkspaceValue,
  renderDetailsBodyAttributes,
  renderDetailsThemeAttributes
} from "../src/ui/details";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("details theme", () => {
  it("reads the configured dashboard theme for details pages", () => {
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: (key: string, defaultValue?: unknown) => (key === "dashboardTheme" ? "light" : defaultValue),
      update: vi.fn()
    } as never);

    expect(getDetailsThemePreference()).toBe("light");
  });

  it("falls back to auto for invalid details theme settings", () => {
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: (key: string, defaultValue?: unknown) => (key === "dashboardTheme" ? "solarized" : defaultValue),
      update: vi.fn()
    } as never);

    expect(getDetailsThemePreference()).toBe("auto");
  });

  it("renders attributes used by shared webview theme styles", () => {
    expect(renderDetailsThemeAttributes("auto")).toBe('data-theme="auto" data-theme-preference="auto"');
    expect(renderDetailsThemeAttributes("dark")).toBe('data-theme="dark" data-theme-preference="dark"');
    expect(renderDetailsThemeAttributes("light")).toBe('data-theme="light" data-theme-preference="light"');
  });

  it("renders the initial privacy mode for details pages", () => {
    expect(renderDetailsBodyAttributes(true)).toBe(' class="privacy-hidden" data-privacy-hidden="true"');
    expect(renderDetailsBodyAttributes(false)).toBe(' data-privacy-hidden="false"');
  });

  it("uses the localized personal workspace label when a personal account has no workspace name", () => {
    expect(getDetailsWorkspaceValue({ accountStructure: "personal" }, "个人空间")).toBe("个人空间");
    expect(getDetailsWorkspaceValue({ accountStructure: "team" }, "团队空间")).toBe("");
    expect(getDetailsWorkspaceValue({ accountStructure: "team", accountName: "Platform" }, "团队空间")).toBe("Platform");
  });
});

describe("details subscription display", () => {
  it("formats subscription expiry with remaining days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-27T00:00:00Z"));

    const expirySeconds = Math.floor(new Date("2026-05-02T00:00:00Z").getTime() / 1000);
    const display = resolveSubscriptionDisplay(
      {
        id: "a",
        email: "a@example.com",
        isActive: true,
        createdAt: 1,
        updatedAt: 1,
        subscriptionActiveUntil: String(expirySeconds)
      },
      undefined,
      getDashboardCopy("zh"),
      "zh"
    );

    expect(display.text).toContain("5 天");
    expect(display.title).toBe(display.text);
    expect(display.color).toBe("#f59e0b");
  });
});
