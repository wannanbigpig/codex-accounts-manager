import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { WakeupStore } from "../src/storage/wakeupStore";
import { WakeupService } from "../src/application/wakeup/service";
import type { WakeupScheduleMode, WakeupTaskInput } from "../src/domain/wakeup/types";

const now = new Date(2026, 9, 15, 6, 0).getTime();
const input: WakeupTaskInput = {
  name: "Independent task",
  enabled: true,
  accountIds: ["a"],
  time: "06:15",
  days: [0, 1, 2, 3, 4, 5, 6],
  model: "gpt-5.6-luna",
  effort: "low",
  prompt: "Reply with OK."
};
let directory: string;
let store: WakeupStore;
const services: WakeupService[] = [];
const releases: Array<() => Promise<void>> = [];
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-wakeup-independent-"));
  store = new WakeupStore(directory);
});
afterEach(async () => {
  services.splice(0).forEach((service) => service.dispose());
  await Promise.all(releases.splice(0).map((release) => release()));
  await fs.rm(directory, { recursive: true, force: true });
});

describe("independent task enablement", () => {
  it.each([1, 2, 3].flatMap((version) => [false, true].map((enabled) => ({ version, enabled }))))(
    "migrates legacy version $version with master switch $enabled while preserving individual states",
    async ({ version, enabled }) => {
      const active = await store.saveTask(input, now);
      const paused = await store.saveTask({ ...input, name: "Paused", enabled: false }, now);
      const file = path.join(directory, "tasks.json");
      const legacy = JSON.stringify({ ...(await store.read()), version, enabled });
      await fs.writeFile(file, legacy);
      const migrated = await store.read();
      expect(migrated.version).toBe(4);
      expect(migrated).not.toHaveProperty("enabled");
      expect(migrated.tasks.map((task) => task.enabled)).toEqual([true, false]);
      // Reads do not rewrite a file outside the shared state lease.
      expect(await fs.readFile(file, "utf8")).toBe(legacy);
      expect(await store.claim(active.id, "scheduled", active.nextRunAt, active.nextRunAt)).toBeDefined();
      expect(await store.claim(paused.id, "scheduled", paused.nextRunAt, paused.nextRunAt)).toBeUndefined();
      const persisted = JSON.parse(await fs.readFile(file, "utf8"));
      expect(persisted.version).toBe(4);
      expect(persisted).not.toHaveProperty("enabled");
    }
  );

  it.each<WakeupScheduleMode>(["daily", "weekly", "interval", "quota_reset", "startup"])(
    "runs only enabled %s tasks without a global switch",
    async (scheduleMode) => {
      const mode = { scheduleMode, intervalMinutes: 1, quotaResetWindow: "hourly" as const, startupDelayMinutes: 1 };
      const active = await store.saveTask({ ...input, ...mode }, now);
      await store.saveTask({ ...input, ...mode, enabled: false, accountIds: ["b"] }, now);
      const membership = await store.joinSchedulerSession(now, () => undefined);
      releases.push(membership.release);
      const due = scheduleMode === "startup" || scheduleMode === "quota_reset" ? now + 60_000 : active.nextRunAt;
      const execute = vi.fn(async (_id: string) => undefined);
      const owner = new WakeupService(
        store,
        {
          getAccount: async (id) => ({
            id,
            email: `${id}@example.test`,
            isActive: false,
            createdAt: now,
            updatedAt: now,
            lastQuotaAt: now,
            quotaSummary: { hourlyPercentage: 0, weeklyPercentage: 50, hourlyResetTime: due / 1000 }
          })
        },
        execute,
        () => undefined,
        () => due
      );
      services.push(owner);
      await owner.poll();
      expect(execute.mock.calls.map((call) => call[0])).toEqual(["a"]);
      expect((await store.read()).history).toMatchObject([{ taskId: active.id, status: "success" }]);
    }
  );
});
