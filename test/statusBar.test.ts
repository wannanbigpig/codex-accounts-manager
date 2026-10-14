import * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAccountRecord, CodexQuotaSummary } from "../src/core/types";
import { isHourlyQuotaControlEnabled } from "../src/infrastructure/config/extensionSettings";
import { setCurrentWindowRuntimeAccountId } from "../src/presentation/workbench/windowRuntimeAccount";
import type { AccountsRepository } from "../src/storage";
import {
  AccountsStatusBarProvider,
  buildStatusText,
  buildThinBar,
  renderAccountPanel,
  renderMetricRow
} from "../src/ui/statusBar";

const { statusBarItem } = vi.hoisted(() => ({
  statusBarItem: {
    text: "",
    tooltip: undefined as { value: string } | undefined,
    show: vi.fn(),
    dispose: vi.fn()
  }
}));

vi.mock("vscode", () => ({
  env: { language: "en" },
  commands: { executeCommand: vi.fn() },
  workspace: {
    getConfiguration: vi.fn(() => ({ get: (_key: string, defaultValue?: unknown) => defaultValue })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() }))
  },
  window: { createStatusBarItem: vi.fn(() => statusBarItem) },
  StatusBarAlignment: { Right: 2 },
  MarkdownString: class {
    value = "";
    appendMarkdown(value: string) {
      this.value += value;
      return this;
    }
  }
}));

beforeEach(() => {
  vi.resetAllMocks();
  setCurrentWindowRuntimeAccountId();
  statusBarItem.text = "";
  statusBarItem.tooltip = undefined;
});

const account: CodexAccountRecord = {
  id: "account-1",
  email: "dev@example.com",
  isActive: true,
  createdAt: 1,
  updatedAt: 1,
  quotaSummary: {
    hourlyPercentage: 37,
    hourlyWindowPresent: true,
    weeklyPercentage: 82,
    weeklyWindowPresent: true,
    codeReviewPercentage: 0,
    additionalRateLimits: [
      {
        limitName: "Spark",
        hourlyPercentage: 12,
        hourlyWindowPresent: true,
        weeklyPercentage: 71,
        weeklyWindowPresent: true
      }
    ]
  }
};

function accountWithQuota(overrides: Partial<CodexQuotaSummary>): CodexAccountRecord {
  return { ...account, quotaSummary: { ...account.quotaSummary!, ...overrides } };
}

describe("AccountsStatusBarProvider", () => {
  it("shows both quotas and hover details while 5-hour automation is disabled", async () => {
    const primary = { ...account, lastQuotaAt: 1_790_000_000_000 };
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    const repo = { listAccounts: vi.fn().mockResolvedValue([primary]) } as unknown as AccountsRepository;
    const provider = new AccountsStatusBarProvider(context, repo);

    expect(isHourlyQuotaControlEnabled()).toBe(false);
    await provider.refresh();

    expect(statusBarItem.text).toBe("$(dashboard) Codex 5h 37% · Wk 82%");
    expect(statusBarItem.tooltip?.value).toContain("37%");
    expect(statusBarItem.tooltip?.value).toContain("Spark");
    expect(statusBarItem.tooltip?.value).toContain("12%");
    expect(statusBarItem.tooltip?.value).toContain("Last Refresh:");
    expect(statusBarItem.tooltip?.value).not.toContain("Never");
    expect(statusBarItem.show).toHaveBeenCalledOnce();
  });

  it("continues to show the current window's account instead of a different global account", async () => {
    const windowAccount = { ...accountWithQuota({ hourlyPercentage: 64 }), id: "window-account", isActive: false };
    setCurrentWindowRuntimeAccountId(windowAccount.id);
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    const repo = { listAccounts: vi.fn().mockResolvedValue([account, windowAccount]) } as unknown as AccountsRepository;

    await new AccountsStatusBarProvider(context, repo).refresh();

    expect(statusBarItem.text).toBe("$(dashboard) Codex 5h 64% · Wk 82%");
    expect(statusBarItem.tooltip?.value).toContain("37%");
  });
});

describe("buildStatusText", () => {
  it("labels both remaining percentages", () => {
    expect(buildStatusText(account)).toBe("$(dashboard) Codex 5h 37% · Wk 82%");
  });

  it("hides an absent 5-hour window instead of showing its normalized 100% fallback", () => {
    expect(buildStatusText(accountWithQuota({ hourlyWindowPresent: false, hourlyPercentage: 100 }))).toBe(
      "$(dashboard) Codex Wk 82%"
    );
  });

  it("shows a zero 5-hour balance when the weekly window is absent", () => {
    expect(buildStatusText(accountWithQuota({ hourlyPercentage: 0, weeklyWindowPresent: false }))).toBe(
      "$(dashboard) Codex 5h 0%"
    );
  });

  it("does not invent quota values when both windows are absent", () => {
    expect(buildStatusText(accountWithQuota({ hourlyWindowPresent: false, weeklyWindowPresent: false }))).toBe(
      "$(dashboard) Codex --"
    );
  });

  it("keeps legacy numeric quotas visible when presence flags are unavailable", () => {
    expect(buildStatusText(accountWithQuota({ hourlyWindowPresent: undefined, weeklyWindowPresent: undefined }))).toBe(
      "$(dashboard) Codex 5h 37% · Wk 82%"
    );
  });

  it.each([
    ["free", undefined],
    ["plus", 43_200]
  ])("labels monthly quota windows using Mo (%s, %s)", (planType, weeklyWindowMinutes) => {
    expect(buildStatusText({ ...accountWithQuota({ weeklyWindowMinutes }), planType })).toBe(
      "$(dashboard) Codex 5h 37% · Mo 82%"
    );
  });

  it("keeps compact labels in English when the UI language is Chinese", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: () => "zh"
    } as unknown as vscode.WorkspaceConfiguration);

    expect(buildStatusText(account)).toBe("$(dashboard) Codex 5h 37% · Wk 82%");
  });

  it("shows placeholders before the first quota refresh", () => {
    expect(buildStatusText({ ...account, quotaSummary: undefined })).toBe("$(dashboard) Codex 5h -- · Wk --");
  });

  it("shows placeholders instead of NaN or Infinity", () => {
    expect(
      buildStatusText(accountWithQuota({ hourlyPercentage: Number.NaN, weeklyPercentage: Number.POSITIVE_INFINITY }))
    ).toBe("$(dashboard) Codex 5h -- · Wk --");
  });
});

describe("renderAccountPanel", () => {
  it("normalizes raw ChatGPT plan identifiers", () => {
    const teamPanel = renderAccountPanel({ ...account, planType: "chatgptteamplan" }, true, true);
    const plusPanel = renderAccountPanel({ ...account, planType: "chatgptplusplan" }, false, false);

    expect(teamPanel).toContain("Business");
    expect(teamPanel).not.toContain("CHATGPTTEAMPLAN");
    expect(plusPanel).toContain("Plus");
    expect(plusPanel).not.toContain("CHATGPTPLUSPLAN");
  });

  it("does not invent a Business plan when the plan is unknown", () => {
    const panel = renderAccountPanel(account, true, true);

    expect(panel).toContain("unknown");
    expect(panel).not.toContain("Business");
  });

  it("shows Code Review when that window is present", () => {
    const panel = renderAccountPanel(
      {
        ...account,
        quotaSummary: {
          ...account.quotaSummary!,
          codeReviewPercentage: 66,
          codeReviewWindowPresent: true
        }
      },
      true,
      true
    );

    expect(panel).toContain("Review");
    expect(panel).toContain("66%");
  });

  it("hides absent quota windows in the tooltip", () => {
    const panel = renderAccountPanel(
      accountWithQuota({ hourlyWindowPresent: false, weeklyWindowPresent: false }),
      true,
      true
    );

    expect(panel).not.toContain("37%");
    expect(panel).not.toContain("82%");
    expect(panel).toContain("12%");
    expect(panel).toContain("71%");
  });

  it("shows all available quota windows", () => {
    const panel = renderAccountPanel(account, true, true);

    expect(panel).toContain("37%");
    expect(panel).toContain("12%");
    expect(panel).toContain("82%");
    expect(panel).toContain("71%");
  });

  it("labels a Free 30-day quota as monthly", () => {
    const panel = renderAccountPanel(
      {
        ...account,
        planType: "free",
        quotaSummary: {
          ...account.quotaSummary,
          weeklyWindowMinutes: 43_200
        }
      },
      true,
      true
    );

    expect(panel).toContain("Monthly");
  });
});

describe("buildThinBar", () => {
  it("renders an empty bar for zero percent", () => {
    expect(buildThinBar(0, 5)).toBe("▱▱▱▱▱");
  });

  it("renders a full bar for one hundred percent", () => {
    expect(buildThinBar(100, 5)).toBe("▰▰▰▰▰");
  });

  it("renders a neutral bar when percentage is unavailable", () => {
    expect(buildThinBar(undefined, 5)).toBe("╌╌╌╌╌");
  });
});

describe("renderMetricRow", () => {
  it("does not force inline code styling in the native tooltip", () => {
    const row = renderMetricRow("5 小时", 79);

    expect(row).toContain("5 小时");
    expect(row).toContain("79%");
    expect(row).not.toContain("`");
  });
});
