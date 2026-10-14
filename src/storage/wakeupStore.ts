import * as fs from "fs/promises";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { lock, check } from "proper-lockfile";
import { nextWakeupAt, validateWakeupTask } from "../domain/wakeup/schedule";
import type {
  WakeupAccountResult,
  WakeupRun,
  WakeupRunStatus,
  WakeupState,
  WakeupTask,
  WakeupTaskInput
} from "../domain/wakeup/types";
import { WAKEUP_GRACE_MS } from "../domain/wakeup/types";
import { createKeyedMutex } from "../utils/concurrency";

const LOCK_OPTIONS = { realpath: false, stale: 60_000, update: 10_000 };

/** Shared by all VS Code windows and profiles on this machine. Contains no tokens. */
export class WakeupStore {
  private readonly statePath: string;
  private readonly mutex = createKeyedMutex();

  constructor(readonly directory: string) {
    this.statePath = path.join(directory, "tasks.json");
  }

  async read(): Promise<WakeupState> {
    let raw: string;
    try {
      raw = await fs.readFile(this.statePath, "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return {
          version: 1,
          enabled: false,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          tasks: [],
          history: []
        };
      }
      throw error;
    }
    const state = JSON.parse(raw) as WakeupState;
    if (
      (state?.version !== 1 && state?.version !== 2) ||
      typeof state.enabled !== "boolean" ||
      typeof state.timeZone !== "string" ||
      !Array.isArray(state.tasks) ||
      !Array.isArray(state.history)
    ) {
      throw new Error("Wakeup task storage is invalid; existing data was preserved");
    }
    for (const task of state.tasks) {
      validateWakeupTask(task);
      if (
        !task.id ||
        !Number.isFinite(task.nextRunAt) ||
        !Number.isFinite(task.createdAt) ||
        !Number.isFinite(task.updatedAt)
      ) {
        throw new Error("Wakeup schedule storage is invalid; existing data was preserved");
      }
    }
    if (
      state.history.some(
        (run) =>
          !run.id ||
          !run.taskId ||
          typeof run.taskName !== "string" ||
          !["scheduled", "manual"].includes(run.trigger) ||
          !["running", "success", "partial", "failed", "cancelled", "interrupted", "missed"].includes(run.status) ||
          !Number.isFinite(run.startedAt) ||
          !Number.isInteger(run.ownerPid) ||
          !Array.isArray(run.results) ||
          run.results.some(
            (result) =>
              !result ||
              typeof result.accountId !== "string" ||
              !["success", "failed", "cancelled"].includes(result.status) ||
              (result.message !== undefined && typeof result.message !== "string")
          )
      )
    ) {
      throw new Error("Wakeup history storage is invalid; existing data was preserved");
    }
    return state;
  }

  async saveTask(input: WakeupTaskInput, now = Date.now()): Promise<WakeupTask> {
    const valid = validateWakeupTask(input);
    return this.mutate((state) => {
      const previous = valid.id ? state.tasks.find((task) => task.id === valid.id) : undefined;
      if (valid.id && !previous) {
        throw new Error("Wakeup task no longer exists");
      }
      if (!previous && state.tasks.length >= 100) {
        throw new Error("A maximum of 100 wakeup tasks is supported");
      }
      const task: WakeupTask = {
        ...valid,
        id: previous?.id ?? randomUUID(),
        createdAt: previous?.createdAt ?? now,
        updatedAt: Math.max(now, (previous?.updatedAt ?? 0) + 1),
        nextRunAt: nextWakeupAt(valid, now),
        lastScheduledAt: previous?.lastScheduledAt
      };
      state.tasks = previous ? state.tasks.map((item) => (item.id === task.id ? task : item)) : [...state.tasks, task];
      if (task.scheduleMode === "interval") {
        state.version = 2;
      }
      return task;
    });
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (typeof enabled !== "boolean") {
      throw new Error("Invalid wakeup enabled state");
    }
    await this.mutate((state) => {
      state.enabled = enabled;
    });
  }

  async setTaskEnabled(id: string, enabled: boolean, now = Date.now()): Promise<void> {
    if (typeof enabled !== "boolean") {
      throw new Error("Invalid task enabled state");
    }
    await this.mutate((state) => {
      const task = state.tasks.find((item) => item.id === id);
      if (!task) {
        throw new Error("Wakeup task no longer exists");
      }
      task.enabled = enabled;
      task.updatedAt = Math.max(now, task.updatedAt + 1);
      if (enabled) {
        task.nextRunAt = nextWakeupAt(validateWakeupTask(task), now);
      }
    });
  }

  async removeTask(id: string): Promise<void> {
    await this.mutate((state) => {
      state.tasks = state.tasks.filter((task) => task.id !== id);
    });
  }

  /** The lease spans execution; its heartbeat is independent of a visible Webview. */
  async tryRunLease(taskId: string, onCompromised: (error: Error) => void): Promise<(() => Promise<void>) | undefined> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      return await lock(this.runPath(taskId), { ...LOCK_OPTIONS, retries: 0, onCompromised });
    } catch (error) {
      if (hasCode(error, "ELOCKED")) {
        return undefined;
      }
      throw error;
    }
  }

  /** Commit the occurrence before any paid request. A failed/uncertain request is never replayed automatically. */
  async claim(
    taskId: string,
    trigger: "scheduled" | "manual",
    expectedDue: number | undefined,
    now = Date.now()
  ): Promise<{ task: WakeupTask; run: WakeupRun } | undefined> {
    return this.mutate(async (state) => {
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task) {
        return undefined;
      }
      if (trigger === "scheduled") {
        if (
          !state.enabled ||
          !task.enabled ||
          task.nextRunAt !== expectedDue ||
          expectedDue === undefined ||
          expectedDue > now
        ) {
          return undefined;
        }
        task.nextRunAt = nextWakeupAt(task, now);
        if ((task.lastScheduledAt ?? 0) >= expectedDue) {
          return undefined;
        }
        task.lastScheduledAt = expectedDue;
      }
      const run: WakeupRun = {
        id: randomUUID(),
        taskId,
        taskName: task.name,
        trigger,
        scheduledAt: expectedDue,
        startedAt: now,
        ownerPid: process.pid,
        status: "running",
        results: []
      };
      if (trigger === "scheduled" && now - expectedDue! > WAKEUP_GRACE_MS) {
        run.status = "missed";
        run.finishedAt = now;
        state.history = [run, ...state.history].slice(0, 100);
        return undefined;
      }
      if (trigger === "scheduled") {
        const claimsDirectory = path.join(this.directory, "claims");
        await fs.mkdir(claimsDirectory, { recursive: true, mode: 0o700 });
        const key = createHash("sha256").update(`${taskId}:${expectedDue}`).digest("hex");
        try {
          const claim = await fs.open(path.join(claimsDirectory, key), "wx", 0o600);
          try {
            await claim.writeFile(JSON.stringify({ runId: run.id, scheduledAt: expectedDue }));
            await claim.sync();
          } finally {
            await claim.close();
          }
        } catch (error) {
          if (hasCode(error, "EEXIST")) {
            return undefined;
          }
          throw error;
        }
      }
      state.history = [run, ...state.history].slice(0, 100);
      return { task: { ...task }, run };
    });
  }

  async addResult(runId: string, result: WakeupAccountResult): Promise<void> {
    await this.mutate((state) => {
      const run = state.history.find((item) => item.id === runId);
      if (run?.status === "running") {
        run.results.push(result);
      }
    });
  }

  async finish(runId: string, status: WakeupRunStatus, now = Date.now()): Promise<void> {
    await this.mutate((state) => {
      const run = state.history.find((item) => item.id === runId);
      if (run?.status === "running") {
        run.status = status;
        run.finishedAt = now;
      }
    });
  }

  async recoverInterrupted(now = Date.now()): Promise<void> {
    const current = await this.read();
    if (!current.history.some((run) => run.status === "running")) {
      return;
    }
    await this.mutate(async (state) => {
      for (const run of state.history.filter((item) => item.status === "running")) {
        if (!(await check(this.runPath(run.taskId), LOCK_OPTIONS))) {
          run.status = "interrupted";
          run.finishedAt = now;
        }
      }
    });
  }

  private runPath(taskId: string): string {
    return path.join(this.directory, `run-${createHash("sha256").update(taskId).digest("hex")}`);
  }

  private async mutate<T>(operation: (state: WakeupState) => T | Promise<T>): Promise<T> {
    return this.mutex.runExclusive("state", async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      let compromised: Error | undefined;
      const release = await lock(this.statePath, {
        ...LOCK_OPTIONS,
        retries: { retries: 20, minTimeout: 20, maxTimeout: 150 },
        onCompromised: (error) => {
          compromised = error;
        }
      });
      try {
        const state = await this.read();
        const result = await operation(state);
        if (compromised) {
          throw compromised;
        }
        const temporary = `${this.statePath}.${randomUUID()}.tmp`;
        try {
          const file = await fs.open(temporary, "wx", 0o600);
          try {
            await file.writeFile(JSON.stringify(state, null, 2));
            await file.sync();
          } finally {
            await file.close();
          }
          await fs.rename(temporary, this.statePath);
        } finally {
          await fs.rm(temporary, { force: true });
        }
        return result;
      } finally {
        await release();
      }
    });
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
