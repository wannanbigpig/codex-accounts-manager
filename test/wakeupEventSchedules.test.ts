import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { WakeupService } from "../src/application/wakeup/service";
import { WakeupStore } from "../src/storage/wakeupStore";
import { validateWakeupTask, nextWakeupAt, resolveWakeupScheduleMode } from "../src/domain/wakeup/schedule";
import type { WakeupTaskInput } from "../src/domain/wakeup/types";
import type { CodexAccountRecord } from "../src/core/types";
const input: WakeupTaskInput = {
  name: "Fixture",
  enabled: true,
  accountIds: ["a", "b"],
  time: "06:15",
  days: [1],
  model: "gpt-5.6-luna",
  effort: "low",
  prompt: "Reply with OK."
};
const now = new Date(2026, 9, 14, 6, 0).getTime();
let directory: string;
let store: WakeupStore;
const services: WakeupService[] = [];
const releases: Array<() => Promise<void>> = [];
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-wakeup-events-"));
  store = new WakeupStore(directory);
});
afterEach(async () => {
  services.splice(0).forEach((service) => service.dispose());
  await Promise.all(releases.splice(0).map((release) => release()));
  await vi.waitFor(async () =>
    expect(
      (await fs.readdir(path.join(directory, "hosts")).catch(() => [])).filter((name) => name.endsWith(".json"))
    ).toEqual([])
  );
  await fs.rm(directory, { recursive: true, force: true });
});
const account = (id: string, resetMs?: number, observedAt = now): CodexAccountRecord => ({
  id,
  email: `${id}@example.test`,
  isActive: false,
  createdAt: 1,
  updatedAt: observedAt,
  lastQuotaAt: observedAt,
  quotaSummary: resetMs ? { hourlyPercentage: 0, weeklyPercentage: 50, hourlyResetTime: resetMs / 1000 } : undefined
});
describe("expanded wakeup modes", () => {
  it("preserves legacy weekday selections when duplicate days are present", () => {
    expect(resolveWakeupScheduleMode({ days: [0, 0, 1, 2, 3, 4, 5], scheduleMode: "calendar" })).toBe("weekly");
    expect(resolveWakeupScheduleMode({ days: [0, 1, 2, 3, 4, 5, 6, 6] })).toBe("daily");
  });
  it("normalizes daily independently of weekdays and preserves selected weekdays for weekly", () => {
    const daily = validateWakeupTask({ ...input, scheduleMode: "daily", days: [] });
    expect(daily.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(nextWakeupAt(daily, now)).toBe(now + 15 * 60_000);
    const weekly = validateWakeupTask({ ...input, scheduleMode: "weekly", days: [1, 5] });
    expect(nextWakeupAt(weekly, now)).toBe(new Date(2026, 9, 16, 6, 15).getTime());
  });
  it.each([
    { scheduleMode: "startup", startupDelayMinutes: 0 },
    { scheduleMode: "quota_reset", quotaResetWindow: "either" }
  ])("validates event mode without calendar fields %j", (mode) => {
    const task = validateWakeupTask({ ...input, ...mode, time: "", days: [] } as WakeupTaskInput);
    expect(nextWakeupAt(task, now)).toBe(0);
  });
  it.each([-1, 0.5, 1441, "0"])("rejects invalid startup delay %j", (startupDelayMinutes) =>
    expect(() =>
      validateWakeupTask({ ...input, scheduleMode: "startup", startupDelayMinutes } as WakeupTaskInput)
    ).toThrow()
  );
  it("rejects an unsupported quota reset window", () =>
    expect(() =>
      validateWakeupTask({ ...input, scheduleMode: "quota_reset", quotaResetWindow: "unknown" } as WakeupTaskInput)
    ).toThrow());
  it("uses format 4 for independent task states while retaining existing calendar tasks", async () => {
    const legacy = await store.saveTask(input, now);
    await store.saveTask({ ...input, scheduleMode: "startup", startupDelayMinutes: 0 }, now);
    expect((await store.read()).version).toBe(4);
    expect((await store.read()).tasks[0]!.nextRunAt).toBe(legacy.nextRunAt);
  });
});
describe("startup occurrences shared across active windows", () => {
  it("shares one delayed occurrence until all windows stop, then arms one on the next startup", async () => {
    const task = await store.saveTask({ ...input, scheduleMode: "startup", startupDelayMinutes: 2 }, now);
    const first = await store.joinSchedulerSession(now, () => {});
    releases.push(first.release);
    const second = await new WakeupStore(directory).joinSchedulerSession(now + 10_000, () => {});
    releases.push(second.release);
    expect(second.session.id).toBe(first.session.id);
    expect((await store.read()).tasks[0]!.nextRunAt).toBe(now + 120_000);
    expect(await store.claim(task.id, "scheduled", now + 120_000, now + 119_000)).toBeUndefined();
    const claimed = await store.claim(task.id, "scheduled", now + 120_000, now + 120_000);
    expect(claimed).toBeDefined();
    await store.finish(claimed!.run.id, "success", now + 121_000);
    const third = await new WakeupStore(directory).joinSchedulerSession(now + 200_000, () => {});
    releases.push(third.release);
    expect(third.session.id).toBe(first.session.id);
    expect((await store.read()).tasks[0]!.nextRunAt).toBe(0);
    await Promise.all(releases.splice(0).map((release) => release()));
    const restarted = await store.joinSchedulerSession(now + 300_000, () => {});
    releases.push(restarted.release);
    expect(restarted.session.id).not.toBe(first.session.id);
    expect((await store.read()).tasks[0]!.nextRunAt).toBe(now + 420_000);
  });
  it("keeps a live startup batch across a long machine sleep", async () => {
    await store.saveTask({ ...input, scheduleMode: "startup", startupDelayMinutes: 0 }, now);
    const first = await store.joinSchedulerSession(now, () => {});
    releases.push(first.release);
    const wallClock = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(wallClock + 3_600_000);
    try {
      const resumed = await new WakeupStore(directory).joinSchedulerSession(now + 3_600_000, () => {});
      releases.push(resumed.release);
      expect(resumed.session.id).toBe(first.session.id);
    } finally {
      clock.mockRestore();
    }
  });
  it("arms zero delay immediately, and does not arm disabled tasks or new settings in the current session", async () => {
    const task = await store.saveTask({ ...input, scheduleMode: "startup", startupDelayMinutes: 0 }, now);
    await store.saveTask({ ...input, scheduleMode: "startup", startupDelayMinutes: 0, enabled: false }, now);
    const owner = await store.joinSchedulerSession(now + 1_000, () => {});
    releases.push(owner.release);
    expect((await store.read()).tasks.map((task) => task.nextRunAt)).toEqual([now + 1_000, 0]);
    await store.saveTask({ ...task, startupDelayMinutes: 1 }, now + 2_000);
    expect((await store.read()).tasks[0]!.nextRunAt).toBe(0);
  });
  it("applies a resumed startup task on the next batch without affecting the current batch", async () => {
    const task = await store.saveTask(
      { ...input, enabled: false, scheduleMode: "startup", startupDelayMinutes: 0 },
      now
    );
    const owner = await store.joinSchedulerSession(now + 1_000, () => {});
    releases.push(owner.release);
    await store.setTaskEnabled(task.id, true, now + 2_000);
    expect((await store.read()).tasks[0]!.nextRunAt).toBe(0);
    await releases.pop()!();
    const next = await store.joinSchedulerSession(now + 3_000, () => {});
    releases.push(next.release);
    expect((await store.read()).tasks[0]!.nextRunAt).toBe(now + 3_000);
  });
});
describe("quota reset occurrences", () => {
  it("waits for reset data and dispatches only the accounts whose window resets at that occurrence", async () => {
    const task = await store.saveTask({ ...input, scheduleMode: "quota_reset", quotaResetWindow: "hourly" }, now);
    await store.syncQuotaSchedules(async (id) => account(id));
    expect((await store.read()).tasks[0]!.nextRunAt).toBe(0);
    const dueA = now + 60_000,
      dueB = now + 120_000;
    const read = async (id: string) => account(id, id === "a" ? dueA : dueB);
    await store.syncQuotaSchedules(read);
    expect((await store.read()).tasks[0]!.nextRunAt).toBe(dueA);
    const first = await store.claim(task.id, "scheduled", dueA, dueA);
    expect(first!.task.accountIds).toEqual(["a"]);
    await store.finish(first!.run.id, "success", dueA);
    await store.syncQuotaSchedules(read);
    expect((await store.read()).tasks[0]!.nextRunAt).toBe(dueB);
    const second = await store.claim(task.id, "scheduled", dueB, dueB);
    expect(second!.task.accountIds).toEqual(["b"]);
    await store.finish(second!.run.id, "success", dueB);
    await store.syncQuotaSchedules(read);
    expect((await store.read()).tasks[0]!.nextRunAt).toBe(0);
    expect((await store.read()).tasks[0]!.accountIds).toEqual(["a", "b"]);
  });
  it("does not let an older window's quota snapshot replace newer reset times", async () => {
    await store.saveTask({ ...input, accountIds: ["a"], scheduleMode: "quota_reset", quotaResetWindow: "hourly" }, now);
    await store.syncQuotaSchedules(async () => account("a", now + 120_000, now + 1000));
    await store.syncQuotaSchedules(async () => account("a", now + 60_000, now));
    expect((await store.read()).tasks[0]!.nextRunAt).toBe(now + 120_000);
  });
  it("selects the long window and additional model limits without guessing missing timestamps", async () => {
    await store.saveTask({ ...input, accountIds: ["a"], scheduleMode: "quota_reset", quotaResetWindow: "weekly" }, now);
    const record = account("a", now + 60_000);
    record.quotaSummary!.weeklyResetTime = (now + 300_000) / 1000;
    record.quotaSummary!.additionalRateLimits = [{ limitName: "model", weeklyResetTime: (now + 180_000) / 1000 }];
    await store.syncQuotaSchedules(async () => record);
    expect((await store.read()).tasks[0]!.nextRunAt).toBe(now + 180_000);
  });
});

describe("event modes through the running scheduler", () => {
  it("executes a zero-delay startup once across live windows", async () => {
    await store.saveTask({ ...input, accountIds: ["a"], scheduleMode: "startup", startupDelayMinutes: 0 }, now);
    const execute = vi.fn(async (_id: string) => undefined);
    const first = new WakeupService(
      store,
      { getAccount: async (id) => account(id) },
      execute,
      () => {},
      () => now + 1000
    );
    const second = new WakeupService(
      new WakeupStore(directory),
      { getAccount: async (id) => account(id) },
      execute,
      () => {},
      () => now + 2000
    );
    services.push(first, second);
    await first.start();
    await second.start();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await first.poll();
    await second.poll();
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await store.read()).history).toHaveLength(1);
  });
  it("cancels a delayed startup when its task is paused", async () => {
    const task = await store.saveTask(
      { ...input, accountIds: ["a"], scheduleMode: "startup", startupDelayMinutes: 2 },
      now
    );
    let clock = now + 1000;
    const execute = vi.fn(async (_id: string) => undefined);
    const owner = new WakeupService(
      store,
      { getAccount: async (id) => account(id) },
      execute,
      () => {},
      () => clock
    );
    services.push(owner);
    await owner.start();
    await owner.setTaskEnabled(task.id, false);
    clock += 120_000;
    await owner.poll();
    expect(execute).not.toHaveBeenCalled();
  });
  it("does not block a calendar task when another task cannot read its quota snapshot", async () => {
    await store.saveTask(
      { ...input, accountIds: ["missing"], scheduleMode: "quota_reset", quotaResetWindow: "hourly" },
      now
    );
    await store.saveTask({ ...input, accountIds: ["b"], scheduleMode: "daily" }, now);
    const execute = vi.fn(async (_id: string) => undefined);
    const owner = new WakeupService(
      store,
      {
        getAccount: async (id) => {
          if (id === "missing") {
            throw new Error("Quota storage unavailable");
          }
          return account(id);
        }
      },
      execute,
      () => {},
      () => now + 15 * 60_000
    );
    services.push(owner);
    await owner.poll();
    expect(execute.mock.calls.map((args) => args[0])).toEqual(["b"]);
  });
  it("wakes each account at its own quota reset without replaying consumed times", async () => {
    await store.saveTask({ ...input, scheduleMode: "quota_reset", quotaResetWindow: "hourly" }, now);
    let clock = now + 60_000;
    const execute = vi.fn(async (_id: string) => undefined);
    const owner = new WakeupService(
      store,
      { getAccount: async (id) => account(id, now + (id === "a" ? 60_000 : 120_000)) },
      execute,
      () => {},
      () => clock
    );
    services.push(owner);
    await owner.poll();
    expect(execute.mock.calls.map((args) => args[0])).toEqual(["a"]);
    clock = now + 120_000;
    await owner.poll();
    await owner.poll();
    expect(execute.mock.calls.map((args) => args[0])).toEqual(["a", "b"]);
  });
});
