import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountsRepository } from "../src/storage";
import type { AccountsStatusBarProvider } from "../src/ui";
import type { WakeupSnapshot } from "../src/domain/wakeup/types";

const { refreshDashboard, refreshDetails, snapshot } = vi.hoisted(() => ({
  refreshDashboard: vi.fn(),
  refreshDetails: vi.fn(),
  snapshot: vi.fn()
}));
vi.mock("../src/commands", () => ({ refreshImportedAccountQuota: vi.fn() }));
vi.mock("../src/presentation/dashboard", () => ({ refreshQuotaSummaryPanel: refreshDashboard }));
vi.mock("../src/ui", () => ({ refreshDetailsPanel: refreshDetails }));
vi.mock("../src/presentation/workbench/wakeupRegistration", () => ({
  getWakeupService: () => ({ snapshot })
}));
import { WorkbenchRefreshCoordinator } from "../src/presentation/workbench/refreshCoordinator";

let wakeup: WakeupSnapshot;
beforeEach(() => {
  vi.clearAllMocks();
  wakeup = { version: 4, timeZone: "Asia/Shanghai", tasks: [], history: [] };
  snapshot.mockImplementation(async () => structuredClone(wakeup));
});
function coordinator(): WorkbenchRefreshCoordinator {
  return new WorkbenchRefreshCoordinator(
    {} as never,
    {
      listAccounts: async () => [],
      getIndexHealthSummary: async () => ({ status: "healthy", availableBackups: 0 })
    } as unknown as AccountsRepository,
    { refresh: vi.fn() } as unknown as AccountsStatusBarProvider
  );
}

describe("workbench wakeup refresh", () => {
  it("publishes an individual task switch change while account state is unchanged", async () => {
    wakeup.tasks.push({
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
    });
    const owner = coordinator();
    try {
      await owner.refreshViewsIfNeeded();
      await owner.refreshViewsIfNeeded();
      expect(refreshDashboard).toHaveBeenCalledTimes(1);
      wakeup.tasks[0]!.enabled = true;
      owner.createRefreshView().refresh();
      await vi.waitFor(() => expect(refreshDashboard).toHaveBeenCalledTimes(2));
    } finally {
      owner.dispose();
    }
  });
  it("publishes run history changes without depending on a successful quota refresh", async () => {
    const owner = coordinator();
    try {
      await owner.refreshViewsIfNeeded();
      wakeup.history.push({
        id: "run-1",
        taskId: "task-1",
        taskName: "Morning",
        trigger: "scheduled",
        startedAt: 1,
        ownerPid: process.pid,
        status: "running",
        results: []
      });
      await owner.refreshViewsIfNeeded();
      expect(refreshDashboard).toHaveBeenCalledTimes(2);
      wakeup.history[0]!.status = "failed";
      wakeup.history[0]!.finishedAt = 2;
      await owner.refreshViewsIfNeeded();
      expect(refreshDashboard).toHaveBeenCalledTimes(3);
      await owner.refreshViewsIfNeeded();
      expect(refreshDashboard).toHaveBeenCalledTimes(3);
    } finally {
      owner.dispose();
    }
  });
});
