import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardActionContext } from "../src/presentation/dashboard/actionHandlers";
import type { DashboardActionName, DashboardActionPayload } from "../src/domain/dashboard/types";

const { wakeup } = vi.hoisted(() => ({
  wakeup: {
    saveTask: vi.fn(),
    removeTask: vi.fn(),
    setTaskEnabled: vi.fn(),
    setEnabled: vi.fn(),
    runNow: vi.fn()
  }
}));
vi.mock("../src/presentation/workbench/wakeupRegistration", () => ({ getWakeupService: () => wakeup }));
import { executeDashboardActionMessage } from "../src/presentation/dashboard/actionHandlers";
const getAccount = vi.fn();
const publish = vi.fn();
const context = {
  repo: { getAccount },
  resolveLanguage: () => "en",
  schedulePublishState: publish
} as unknown as DashboardActionContext;
beforeEach(() => {
  vi.clearAllMocks();
});
async function action(name: DashboardActionName, payload?: DashboardActionPayload) {
  return executeDashboardActionMessage(context, { type: "dashboard:action", requestId: "test", action: name, payload });
}

describe("wakeup dashboard bridge", () => {
  it("uses a task ID in the payload rather than looking up an account", async () => {
    expect((await action("runWakeupTask", { wakeupTaskId: "task-1" })).status).toBe("completed");
    expect(wakeup.runNow).toHaveBeenCalledWith("task-1");
    expect(getAccount).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalled();
  });
  it("forwards task and master switches to the shared service", async () => {
    await action("toggleWakeupTask", { wakeupTaskId: "task-1", enabled: false });
    await action("setWakeupEnabled", { enabled: true });
    await action("removeWakeupTask", { wakeupTaskId: "task-1" });
    expect(wakeup.setTaskEnabled).toHaveBeenCalledWith("task-1", false);
    expect(wakeup.setEnabled).toHaveBeenCalledWith(true);
    expect(wakeup.removeTask).toHaveBeenCalledWith("task-1");
  });
  it("rejects malformed messages before changing persistent configuration", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect((await action("setWakeupEnabled", {})).status).toBe("failed");
      expect((await action("toggleWakeupTask", { wakeupTaskId: "task-1" })).status).toBe("failed");
      expect((await action("runWakeupTask", {})).status).toBe("failed");
      expect((await action("saveWakeupTask", {})).status).toBe("failed");
      expect(wakeup.setEnabled).not.toHaveBeenCalled();
      expect(wakeup.setTaskEnabled).not.toHaveBeenCalled();
      expect(wakeup.runNow).not.toHaveBeenCalled();
      expect(wakeup.saveTask).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
