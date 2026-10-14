import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { createHash } from "crypto";
import { WakeupStore } from "../src/storage/wakeupStore";
import type { WakeupTaskInput } from "../src/domain/wakeup/types";

const input: WakeupTaskInput = {
  name: "Morning",
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
const releases: Array<() => Promise<void>> = [];
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-wakeup-store-"));
  store = new WakeupStore(directory);
});
afterEach(async () => {
  for (const release of releases.splice(0)) {
    await release();
  }
  await fs.rm(directory, { recursive: true, force: true });
});
const now = new Date(2026, 9, 8, 6, 0).getTime();

describe("shared wakeup storage", () => {
  it("defaults to disabled and serializes independent writers without losing tasks", async () => {
    expect((await store.read()).enabled).toBe(false);
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        new WakeupStore(directory).saveTask({ ...input, name: `Task ${index}` }, now)
      )
    );
    const state = await store.read();
    expect(state.tasks).toHaveLength(8);
    expect(new Set(state.tasks.map((task) => task.id)).size).toBe(8);
  });
  it("reads existing calendar tasks and protects interval schedules from older extension hosts", async () => {
    const calendar = await store.saveTask(input, now);
    const legacy = await store.read();
    delete legacy.tasks[0]!.scheduleMode;
    await fs.writeFile(path.join(directory, "tasks.json"), JSON.stringify(legacy));
    expect((await store.read()).tasks[0]?.nextRunAt).toBe(calendar.nextRunAt);
    const interval = await store.saveTask({ ...input, scheduleMode: "interval", intervalMinutes: 300 }, now);
    const state = await new WakeupStore(directory).read();
    expect(state.version).toBe(2);
    expect(state.tasks).toHaveLength(2);
    expect(state.tasks[1]?.nextRunAt).toBe(interval.nextRunAt);
    expect(state.tasks[0]?.nextRunAt).toBe(calendar.nextRunAt);
  });
  it("advances interval schedules without drift, skips missed cycles, and restarts the countdown on resume", async () => {
    const step = 300 * 60_000;
    const task = await store.saveTask({ ...input, scheduleMode: "interval", intervalMinutes: 300 }, now);
    expect(task.nextRunAt).toBe(now + step);
    await store.setEnabled(true);
    const run = await store.claim(task.id, "scheduled", task.nextRunAt, task.nextRunAt + 45_000);
    expect(run).toBeDefined();
    expect((await store.read()).tasks[0]?.nextRunAt).toBe(now + step * 2);
    const next = now + step * 2;
    expect(await store.claim(task.id, "scheduled", next, now + step * 4 + 300_001)).toBeUndefined();
    expect((await store.read()).tasks[0]?.nextRunAt).toBe(now + step * 5);
    expect((await store.read()).history[0]?.status).toBe("missed");
    const resumed = now + step * 5 + 1_234;
    await store.setTaskEnabled(task.id, false, resumed - 1);
    await store.setTaskEnabled(task.id, true, resumed);
    expect((await store.read()).tasks[0]?.nextRunAt).toBe(resumed + step);
    await store.claim(task.id, "manual", undefined, resumed + 10_000);
    expect((await store.read()).tasks[0]?.nextRunAt).toBe(resumed + step);
  });
  it("only allows one claim across windows, persists it before execution, and never replays failures", async () => {
    const task = await store.saveTask(input, now);
    await store.setEnabled(true);
    const claims = await Promise.all(
      Array.from({ length: 6 }, () =>
        new WakeupStore(directory).claim(task.id, "scheduled", task.nextRunAt, task.nextRunAt)
      )
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    await store.finish(claims.find(Boolean)!.run.id, "failed", task.nextRunAt + 1);
    expect(
      await new WakeupStore(directory).claim(task.id, "scheduled", task.nextRunAt, task.nextRunAt + 100)
    ).toBeUndefined();
    expect((await store.read()).history).toHaveLength(1);
    expect((await store.read()).tasks[0]!.nextRunAt).toBeGreaterThan(task.nextRunAt);
  });
  it("retains a durable claim if the process crashed before updating the state file", async () => {
    const task = await store.saveTask(input, now);
    await store.setEnabled(true);
    const key = createHash("sha256").update(`${task.id}:${task.nextRunAt}`).digest("hex");
    await fs.mkdir(path.join(directory, "claims"));
    await fs.writeFile(path.join(directory, "claims", key), "crash after claim");
    expect(await store.claim(task.id, "scheduled", task.nextRunAt, task.nextRunAt)).toBeUndefined();
    expect((await store.read()).history).toHaveLength(0);
    expect((await store.read()).tasks[0]!.nextRunAt).toBeGreaterThan(task.nextRunAt);
  });
  it("skips a missed occurrence once and advances the schedule", async () => {
    const task = await store.saveTask(input, now);
    await store.setEnabled(true);
    expect(await store.claim(task.id, "scheduled", task.nextRunAt, task.nextRunAt + 300_001)).toBeUndefined();
    expect((await store.read()).history[0]?.status).toBe("missed");
    expect(await store.claim(task.id, "scheduled", task.nextRunAt, task.nextRunAt + 300_002)).toBeUndefined();
    expect((await store.read()).history).toHaveLength(1);
  });
  it("rejects disabled, future, or obsolete occurrences while allowing an explicit manual test", async () => {
    const task = await store.saveTask(input, now);
    expect(await store.claim(task.id, "scheduled", task.nextRunAt, task.nextRunAt)).toBeUndefined();
    await store.setEnabled(true);
    expect(await store.claim(task.id, "scheduled", task.nextRunAt, now)).toBeUndefined();
    expect(await store.claim(task.id, "scheduled", task.nextRunAt - 1, task.nextRunAt)).toBeUndefined();
    await store.setTaskEnabled(task.id, false, now + 1);
    expect(await store.claim(task.id, "scheduled", task.nextRunAt, task.nextRunAt)).toBeUndefined();
    expect(await store.claim(task.id, "manual", undefined, now)).toBeDefined();
  });
  it("uses a live lease to distinguish running and interrupted executions", async () => {
    const task = await store.saveTask(input, now);
    const release = (await store.tryRunLease(task.id, () => undefined))!;
    releases.push(release);
    expect(await new WakeupStore(directory).tryRunLease(task.id, () => undefined)).toBeUndefined();
    await store.claim(task.id, "manual", undefined, now);
    await new WakeupStore(directory).recoverInterrupted(now + 1);
    expect((await store.read()).history[0]?.status).toBe("running");
    await releases.pop()!();
    await new WakeupStore(directory).recoverInterrupted(now + 2);
    expect((await store.read()).history[0]?.status).toBe("interrupted");
  });
  it("preserves malformed storage instead of replacing it", async () => {
    const broken = '{"version":1,"enabled":true,"tasks":';
    await fs.writeFile(path.join(directory, "tasks.json"), broken);
    await expect(store.saveTask(input, now)).rejects.toThrow();
    expect(await fs.readFile(path.join(directory, "tasks.json"), "utf8")).toBe(broken);
  });
  it("rejects corrupt per-account history before publishing it to the dashboard", async () => {
    const task = await store.saveTask(input, now);
    await store.claim(task.id, "manual", undefined, now);
    const state = await store.read();
    state.history[0]!.results = [null] as unknown as (typeof state.history)[0]["results"];
    await fs.writeFile(path.join(directory, "tasks.json"), JSON.stringify(state));
    await expect(store.read()).rejects.toThrow("history storage is invalid");
  });
  it("editing during result writes retains both task and run data", async () => {
    const task = await store.saveTask(input, now);
    const claim = (await store.claim(task.id, "manual", undefined, now))!;
    await Promise.all([
      store.addResult(claim.run.id, { accountId: "a", status: "success" }),
      new WakeupStore(directory).saveTask({ ...task, name: "Edited" }, now + 1)
    ]);
    const state = await store.read();
    expect(state.tasks[0]?.name).toBe("Edited");
    expect(state.history[0]?.results).toEqual([{ accountId: "a", status: "success" }]);
  });
});
