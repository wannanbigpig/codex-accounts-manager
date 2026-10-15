import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { WakeupRequestError } from "../src/domain/wakeup/diagnostics";
import { WakeupStore } from "../src/storage/wakeupStore";
import { WakeupService } from "../src/application/wakeup/service";
import type { WakeupTaskInput } from "../src/domain/wakeup/types";

const input: WakeupTaskInput = {
  name: "Morning",
  enabled: true,
  accountIds: ["a", "b"],
  time: "06:15",
  days: [0, 1, 2, 3, 4, 5, 6],
  model: "gpt-5.6-luna",
  effort: "low",
  prompt: "Reply with OK."
};
const before = new Date(2026, 9, 8, 6, 0).getTime();
const due = new Date(2026, 9, 8, 6, 15).getTime();
const repo = {
  getAccount: async (id: string) => ({ id, email: `${id}@example.test`, createdAt: 0, updatedAt: 0, isActive: false })
};
let directory: string;
let store: WakeupStore;
const services: WakeupService[] = [];
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-wakeup-service-"));
  store = new WakeupStore(directory);
});
afterEach(async () => {
  services.splice(0).forEach((service) => service.dispose());
  await fs.rm(directory, { recursive: true, force: true });
});
function service(execute: ConstructorParameters<typeof WakeupService>[2], now = due): WakeupService {
  const instance = new WakeupService(
    new WakeupStore(directory),
    repo,
    execute,
    () => undefined,
    () => now
  );
  services.push(instance);
  return instance;
}

describe("wakeup execution", () => {
  it("persists task settings, bounded replies, durations and structured failures", async () => {
    const task = await store.saveTask(input, before);
    let now = due;
    const owner = new WakeupService(
      store,
      repo,
      async (id) => {
        now += 1250;
        if (id === "b") {
          throw new WakeupRequestError("HTTP 429 Bearer secret-value", "request", 429);
        }
        return { reply: "OK sk-testsecret " + "x".repeat(600), model: "actual-model", quotaWarning: "quota delayed" };
      },
      () => undefined,
      () => now
    );
    services.push(owner);
    await owner.runNow(task.id);
    const run = (await store.read()).history[0]!;
    expect(run).toMatchObject({ model: input.model, effort: input.effort, status: "partial" });
    expect(run.results[0]).toMatchObject({ durationMs: 1250, model: "actual-model", quotaWarning: "quota delayed" });
    expect(run.results[0]!.reply).toHaveLength(500);
    expect(run.results[0]!.reply).not.toContain("sk-testsecret");
    expect(run.results[1]).toMatchObject({ durationMs: 1250, errorStage: "request", httpStatus: 429 });
    expect(run.results[1]!.message).not.toContain("secret-value");
    await store.saveTask({ ...task, model: "edited-model" }, due);
    expect((await store.read()).history[0]!.model).toBe(input.model);
  });
  it("serializes tasks sharing an account and cancels queued requests on disposal", async () => {
    await store.saveTask({ ...input, name: "First", accountIds: ["a"] }, before);
    await store.saveTask({ ...input, name: "Second", accountIds: ["a"] }, before);
    const execute = vi.fn(
      (_id: string, _task: unknown, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
        })
    );
    const owner = service(execute);
    const polling = owner.poll();
    try {
      await vi.waitFor(async () =>
        expect((await store.read()).history.filter((run) => run.status === "running")).toHaveLength(2)
      );
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      owner.dispose();
      await polling;
    }
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await store.read()).history.every((run) => run.status === "cancelled")).toBe(true);
  });
  it("rejects a manual run in an unavailable window without consuming the schedule", async () => {
    const task = await store.saveTask(input, before);
    const execute = vi.fn(async () => undefined);
    const owner = new WakeupService(store, { getAccount: async () => undefined }, execute, () => undefined);
    services.push(owner);
    await expect(owner.runNow(task.id)).rejects.toThrow("unavailable in this window");
    expect(execute).not.toHaveBeenCalled();
    const state = await store.read();
    expect(state.tasks[0]?.nextRunAt).toBe(task.nextRunAt);
    expect(state.history).toHaveLength(0);
  });
  it("starts other due tasks without waiting for a slow task to finish", async () => {
    const slow = await store.saveTask({ ...input, name: "Slow", accountIds: ["a"] }, before);
    const fast = await store.saveTask({ ...input, name: "Fast", accountIds: ["b"] }, before);
    let now = due;
    let finishSlow!: () => void;
    const slowFinished = new Promise<void>((resolve) => {
      finishSlow = resolve;
    });
    const execute = vi.fn(async (_id: string, task: { id: string }) => {
      if (task.id === slow.id) {
        await slowFinished;
        now = due + 360_000;
      }
    });
    const owner = new WakeupService(
      store,
      repo,
      execute,
      () => undefined,
      () => now
    );
    services.push(owner);
    const polling = owner.poll();
    try {
      await vi.waitFor(() => expect(execute.mock.calls.some(([, task]) => task.id === fast.id)).toBe(true), {
        timeout: 500
      });
    } finally {
      finishSlow();
      await polling;
    }
    expect((await store.read()).history.find((run) => run.taskId === fast.id)?.status).toBe("success");
  });
  it("polls newly due tasks while an earlier scheduled run is still active", async () => {
    const slow = await store.saveTask({ ...input, accountIds: ["a"] }, before);
    const later = await store.saveTask({ ...input, accountIds: ["b"], time: "06:16" }, before);
    let now = due;
    let finishSlow!: () => void;
    const slowFinished = new Promise<void>((resolve) => {
      finishSlow = resolve;
    });
    const execute = vi.fn(async (_id: string, task: { id: string }) => {
      if (task.id === slow.id) {
        await slowFinished;
      }
    });
    const owner = new WakeupService(
      store,
      repo,
      execute,
      () => undefined,
      () => now
    );
    services.push(owner);
    const polling = owner.poll();
    try {
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
      now = due + 60_000;
      await owner.poll();
      expect(execute.mock.calls.some(([, task]) => task.id === later.id)).toBe(true);
    } finally {
      finishSlow();
      await polling;
    }
    expect(execute.mock.calls.filter(([, task]) => task.id === slow.id)).toHaveLength(1);
  });
  it("leaves a shared occurrence for a window containing every selected account", async () => {
    const task = await store.saveTask(input, before);
    const execute = vi.fn(async () => undefined);
    const unavailable = new WakeupService(
      new WakeupStore(directory),
      { getAccount: async (id) => (id === "a" ? repo.getAccount(id) : undefined) },
      execute,
      () => undefined,
      () => due
    );
    services.push(unavailable);
    await unavailable.poll();
    const unclaimed = await store.read();
    expect(unclaimed.tasks[0]?.nextRunAt).toBe(task.nextRunAt);
    expect(unclaimed.history).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
    await service(execute).poll();
    expect(execute).toHaveBeenCalledTimes(2);
    expect((await store.read()).history[0]?.status).toBe("success");
  });
  it("does not let a task preflight error stop other due tasks", async () => {
    const broken = await store.saveTask({ ...input, accountIds: ["a"] }, before);
    const healthy = await store.saveTask({ ...input, accountIds: ["b"] }, before);
    const execute = vi.fn(async () => undefined);
    const owner = new WakeupService(
      store,
      {
        getAccount: async (id) => {
          if (id === "a") {
            throw new Error("Account storage unavailable");
          }
          return repo.getAccount(id);
        }
      },
      execute,
      () => undefined,
      () => due
    );
    services.push(owner);
    await expect(owner.poll()).rejects.toThrow("Account storage unavailable");
    const state = await store.read();
    expect(state.tasks.find((task) => task.id === broken.id)?.nextRunAt).toBe(due);
    expect(state.history.find((run) => run.taskId === healthy.id)?.status).toBe("success");
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("does not dispatch if disposal happens while the occurrence is being claimed", async () => {
    const task = await store.saveTask(input, before);
    const execute = vi.fn(async () => undefined);
    const owner = service(execute);
    const originalClaim = owner.store.claim.bind(owner.store);
    vi.spyOn(owner.store, "claim").mockImplementation(async (...args) => {
      const result = await originalClaim(...args);
      owner.dispose();
      return result;
    });
    await owner.runNow(task.id);
    expect(execute).not.toHaveBeenCalled();
    expect((await store.read()).history[0]?.status).toBe("cancelled");
  });
  it("deduplicates concurrent scheduled polling and continues after one account fails", async () => {
    await store.saveTask(input, before);
    const execute = vi.fn(async (id: string) => {
      if (id === "a") {
        throw new Error("fixture failure");
      }
    });
    await Promise.all([service(execute).poll(), service(execute).poll(), service(execute).poll()]);
    expect(execute.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
    const state = await store.read();
    expect(state.history).toHaveLength(1);
    expect(state.history[0]?.status).toBe("partial");
    await service(execute).poll();
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("does not execute before due or while the task is paused", async () => {
    const task = await store.saveTask({ ...input, enabled: false }, before);
    const execute = vi.fn(async () => undefined);
    await service(execute).poll();
    expect(execute).not.toHaveBeenCalled();
    await store.setTaskEnabled(task.id, true, before);
    await service(execute, before).poll();
    expect(execute).not.toHaveBeenCalled();
    await service(execute).poll();
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("allows a manual test while paused without changing the next scheduled time", async () => {
    const task = await store.saveTask({ ...input, enabled: false }, before);
    const execute = vi.fn(async () => undefined);
    await service(execute).runNow(task.id);
    const state = await store.read();
    expect(state).not.toHaveProperty("enabled");
    expect(state.tasks[0]?.nextRunAt).toBe(task.nextRunAt);
    expect(state.history[0]?.trigger).toBe("manual");
    expect(state.history[0]?.status).toBe("success");
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("aborts only the task paused by another window while another task completes", async () => {
    const task = await store.saveTask(input, before);
    const other = await store.saveTask({ ...input, accountIds: ["c"] }, before);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const execute = vi.fn((id: string, _task: unknown, signal: AbortSignal) =>
      id === "c"
        ? Promise.resolve()
        : new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
            entered();
          })
    );
    const owner = service(execute);
    await owner.start();
    await started;
    await service(async () => undefined).setTaskEnabled(task.id, false);
    await vi.waitFor(async () => {
      const state = await store.read();
      expect(state.history.find((run) => run.taskId === task.id)?.status).toBe("cancelled");
      expect(state.history.find((run) => run.taskId === other.id)?.status).toBe("success");
    });
    expect(execute.mock.calls.map(([id]) => id).sort()).toEqual(["a", "c"]);
  });
  it("prevents duplicate manual runs and stops remaining accounts after disposal", async () => {
    const task = await store.saveTask(input, before);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const execute = vi.fn(
      (_id: string, _task: unknown, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
          entered();
        })
    );
    const owner = service(execute);
    const running = owner.runNow(task.id);
    await started;
    await expect(service(execute).runNow(task.id)).rejects.toThrow("already running");
    owner.dispose();
    await running;
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await store.read()).history[0]?.status).toBe("cancelled");
  });
  it("skips missed tasks without any paid request", async () => {
    await store.saveTask(input, before);
    const execute = vi.fn(async () => undefined);
    await service(execute, due + 300_001).poll();
    expect(execute).not.toHaveBeenCalled();
    expect((await store.read()).history[0]?.status).toBe("missed");
  });
  it("redacts credentials from persistent failure messages and does not automatically retry", async () => {
    await store.saveTask(input, before);
    const execute = vi.fn(async () => {
      throw new Error("failed Bearer private-token eyJprivate.secret sk-private-secret");
    });
    const owner = service(execute);
    await owner.poll();
    await owner.poll();
    expect(execute).toHaveBeenCalledTimes(2);
    expect((await store.read()).history[0]?.status).toBe("failed");
    const raw = await fs.readFile(path.join(directory, "tasks.json"), "utf8");
    expect(raw).not.toContain("private-token");
    expect(raw).not.toContain("private.secret");
    expect(raw).not.toContain("sk-private");
  });
  it("refuses to save deleted accounts without changing configuration", async () => {
    const owner = new WakeupService(
      store,
      { getAccount: async () => undefined },
      async () => undefined,
      () => undefined
    );
    await expect(owner.saveTask(input)).rejects.toThrow("no longer exists");
    expect((await store.read()).tasks).toHaveLength(0);
  });
  it("reports malformed storage with no executable tasks in the dashboard", async () => {
    await fs.writeFile(path.join(directory, "tasks.json"), "broken json");
    const state = await service(async () => undefined).snapshot();
    expect(state).not.toHaveProperty("enabled");
    expect(state.tasks).toEqual([]);
    expect(state.storageError).toBeTruthy();
  });
});
