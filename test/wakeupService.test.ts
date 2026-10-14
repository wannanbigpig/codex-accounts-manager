import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
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
    await store.setEnabled(true);
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
  it("does not execute before due or while automation is disabled", async () => {
    await store.saveTask(input, before);
    const execute = vi.fn(async () => undefined);
    await service(execute).poll();
    expect(execute).not.toHaveBeenCalled();
    await store.setEnabled(true);
    await service(execute, before).poll();
    expect(execute).not.toHaveBeenCalled();
  });
  it("allows a manual test while paused without changing the next scheduled time", async () => {
    const task = await store.saveTask(input, before);
    const execute = vi.fn(async () => undefined);
    await service(execute).runNow(task.id);
    const state = await store.read();
    expect(state.enabled).toBe(false);
    expect(state.tasks[0]?.nextRunAt).toBe(task.nextRunAt);
    expect(state.history[0]?.trigger).toBe("manual");
    expect(state.history[0]?.status).toBe("success");
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("aborts a scheduled run when another window pauses automation", async () => {
    await store.saveTask(input, before);
    await store.setEnabled(true);
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
    await owner.start();
    await started;
    await service(async () => undefined).setEnabled(false);
    await vi.waitFor(async () => expect((await store.read()).history[0]?.status).toBe("cancelled"));
    expect(execute).toHaveBeenCalledTimes(1);
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
    await store.setEnabled(true);
    const execute = vi.fn(async () => undefined);
    await service(execute, due + 300_001).poll();
    expect(execute).not.toHaveBeenCalled();
    expect((await store.read()).history[0]?.status).toBe("missed");
  });
  it("redacts credentials from persistent failure messages and does not automatically retry", async () => {
    await store.saveTask(input, before);
    await store.setEnabled(true);
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
  it("reports malformed storage in the dashboard without enabling automation", async () => {
    await fs.writeFile(path.join(directory, "tasks.json"), "broken json");
    const state = await service(async () => undefined).snapshot();
    expect(state.enabled).toBe(false);
    expect(state.storageError).toBeTruthy();
  });
});
