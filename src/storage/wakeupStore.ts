import * as fs from "fs/promises";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { lock, check } from "proper-lockfile";
import { nextWakeupAt, validateWakeupTask, collectQuotaResetTimes } from "../domain/wakeup/schedule";
import type { CodexAccountRecord } from "../core/types";
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
          version: 4,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          tasks: [],
          history: []
        };
      }
      throw error;
    }
    const state = JSON.parse(raw) as Omit<WakeupState, "version"> & { version: number; enabled?: unknown };
    if (
      ![1, 2, 3, 4].includes(state?.version) ||
      (state.version < 4 && typeof state.enabled !== "boolean") ||
      typeof state.timeZone !== "string" ||
      !Array.isArray(state.tasks) ||
      !Array.isArray(state.history)
    ) {
      throw new Error("Wakeup task storage is invalid; existing data was preserved");
    }
    if (
      state.startupSession &&
      (typeof state.startupSession.id !== "string" || !Number.isFinite(state.startupSession.startedAt))
    ) {
      throw new Error("Wakeup startup storage is invalid; existing data was preserved");
    }
    for (const task of state.tasks) {
      validateWakeupTask(task);
      if (
        !task.id ||
        !Number.isFinite(task.nextRunAt) ||
        !Number.isFinite(task.createdAt) ||
        !Number.isFinite(task.updatedAt) ||
        (task.startupSessionId !== undefined && typeof task.startupSessionId !== "string") ||
        (task.lastStartupSessionId !== undefined && typeof task.lastStartupSessionId !== "string") ||
        (task.nextRunAccountIds !== undefined &&
          (!Array.isArray(task.nextRunAccountIds) ||
            task.nextRunAccountIds.some((id) => !task.accountIds.includes(id)))) ||
        (task.quotaResetSnapshots !== undefined &&
          (typeof task.quotaResetSnapshots !== "object" ||
            task.quotaResetSnapshots === null ||
            Object.entries(task.quotaResetSnapshots).some(
              ([id, snapshot]) =>
                !task.accountIds.includes(id) ||
                !snapshot ||
                !Number.isFinite(snapshot.observedAt) ||
                !Array.isArray(snapshot.times) ||
                snapshot.times.some((time) => !Number.isFinite(time) || time <= 0)
            )))
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
          (run.model !== undefined && typeof run.model !== "string") ||
          (run.effort !== undefined && !["low", "medium", "high"].includes(run.effort)) ||
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
              (result.message !== undefined && typeof result.message !== "string") ||
              (result.reply !== undefined && typeof result.reply !== "string") ||
              (result.model !== undefined && typeof result.model !== "string") ||
              (result.quotaWarning !== undefined && typeof result.quotaWarning !== "string") ||
              (result.durationMs !== undefined && (!Number.isFinite(result.durationMs) || result.durationMs < 0)) ||
              (result.errorStage !== undefined &&
                !["auth", "request", "stream", "timeout", "cancelled"].includes(result.errorStage)) ||
              (result.httpStatus !== undefined &&
                (!Number.isInteger(result.httpStatus) || result.httpStatus < 100 || result.httpStatus > 599))
          )
      )
    ) {
      throw new Error("Wakeup history storage is invalid; existing data was preserved");
    }
    // Keep each task's explicit state; the retired master switch no longer gates execution.
    // The next mutation persists version 4 under the shared lease, preventing older hosts from overwriting it.
    delete state.enabled;
    return { ...state, version: 4 };
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
        lastScheduledAt: previous?.lastScheduledAt,
        lastStartupSessionId: previous?.lastStartupSessionId
      };
      state.tasks = previous ? state.tasks.map((item) => (item.id === task.id ? task : item)) : [...state.tasks, task];
      return task;
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
      if (task.scheduleMode === "startup" || task.scheduleMode === "quota_reset") {
        task.nextRunAt = 0;
        task.nextRunAccountIds = undefined;
        task.startupSessionId = undefined;
      }
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

  /** All live extension hosts share one startup batch; a new batch begins after the last host exits. */
  async joinSchedulerSession(
    now: number,
    onCompromised: (error: Error) => void
  ): Promise<{
    session: { id: string; startedAt: number };
    release: () => Promise<void>;
  }> {
    const hostsDirectory = path.join(this.directory, "hosts");
    await fs.mkdir(hostsDirectory, { recursive: true, mode: 0o700 });
    const hostPath = path.join(hostsDirectory, `${randomUUID()}.json`);
    const releaseLease = await lock(hostPath, { ...LOCK_OPTIONS, retries: 0, onCompromised });
    try {
      const session = await this.mutate(async (state) => {
        let liveHost = false;
        for (const name of await fs.readdir(hostsDirectory)) {
          if (!/^[0-9a-f-]{36}\.json$/.test(name)) {
            continue;
          }
          const memberPath = path.join(hostsDirectory, name);
          try {
            const member = JSON.parse(await fs.readFile(memberPath, "utf8")) as { pid: number };
            if (
              Number.isInteger(member.pid) &&
              member.pid > 0 &&
              isProcessAlive(member.pid) &&
              // Heartbeats pause during machine sleep; a live process with its own lease is still the same startup.
              (await fs.stat(`${memberPath}.lock`).then(
                (stat) => stat.isDirectory(),
                () => false
              ))
            ) {
              liveHost = true;
              break;
            }
            await fs.rm(memberPath, { force: true });
            await fs.rm(`${memberPath}.lock`, { recursive: true, force: true });
          } catch {
            /* Dead or incomplete member records cannot keep a startup batch alive. */
          }
        }
        if (!liveHost || !state.startupSession) {
          state.startupSession = { id: randomUUID(), startedAt: now };
          for (const task of state.tasks.filter((task) => task.scheduleMode === "startup")) {
            task.startupSessionId = state.startupSession.id;
            task.nextRunAt = task.enabled ? now + task.startupDelayMinutes! * 60_000 : 0;
          }
        }
        await fs.writeFile(hostPath, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
        return { ...state.startupSession };
      });
      let released = false;
      return {
        session,
        release: async () => {
          if (released) {
            return;
          }
          released = true;
          try {
            await releaseLease();
          } finally {
            await fs.rm(hostPath, { force: true });
          }
        }
      };
    } catch (error) {
      await releaseLease().catch(() => undefined);
      await fs.rm(hostPath, { force: true });
      throw error;
    }
  }

  async syncQuotaSchedules(getAccount: (id: string) => Promise<CodexAccountRecord | undefined>): Promise<void> {
    const current = await this.read();
    if (!current.tasks.some((task) => task.enabled && task.scheduleMode === "quota_reset")) {
      return;
    }
    await this.mutate(async (state) => {
      const accounts = new Map<string, CodexAccountRecord | undefined>();
      for (const task of state.tasks.filter((task) => task.enabled && task.scheduleMode === "quota_reset")) {
        const snapshots = task.quotaResetSnapshots ?? {};
        for (const id of task.accountIds) {
          if (!accounts.has(id)) {
            try {
              accounts.set(id, await getAccount(id));
            } catch {
              accounts.set(id, undefined);
            }
          }
          const account = accounts.get(id);
          if (!account) {
            continue;
          }
          const observedAt = account.lastQuotaAt ?? 0;
          if (!snapshots[id] || snapshots[id]!.observedAt <= observedAt) {
            snapshots[id] = { observedAt, times: collectQuotaResetTimes(account.quotaSummary, task.quotaResetWindow!) };
          }
        }
        task.quotaResetSnapshots = snapshots;
        const floor = Math.max(task.updatedAt, task.lastScheduledAt ?? 0);
        const times = task.accountIds.flatMap((id) => snapshots[id]?.times ?? []).filter((time) => time > floor);
        task.nextRunAt = times.length ? Math.min(...times) : 0;
        task.nextRunAccountIds = task.accountIds.filter((id) => snapshots[id]?.times.includes(task.nextRunAt));
      }
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
    now = Date.now(),
    canExecute?: (task: WakeupTask) => Promise<boolean>
  ): Promise<{ task: WakeupTask; run: WakeupRun } | undefined> {
    return this.mutate(async (state) => {
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task) {
        return undefined;
      }
      if (trigger === "scheduled") {
        if (
          !task.enabled ||
          task.nextRunAt !== expectedDue ||
          expectedDue === undefined ||
          expectedDue <= 0 ||
          expectedDue > now
        ) {
          return undefined;
        }
      }
      const startup = trigger === "scheduled" && task.scheduleMode === "startup";
      if (
        startup &&
        (!task.startupSessionId ||
          task.startupSessionId !== state.startupSession?.id ||
          task.lastStartupSessionId === task.startupSessionId)
      ) {
        return undefined;
      }
      const executionTask =
        trigger === "scheduled" && task.scheduleMode === "quota_reset"
          ? { ...task, accountIds: [...(task.nextRunAccountIds ?? [])] }
          : task;
      if (!executionTask.accountIds.length) {
        return undefined;
      }
      // Check the latest task under the state lock before consuming its occurrence.
      if (canExecute && !(await canExecute(executionTask))) {
        return undefined;
      }
      if (trigger === "scheduled") {
        task.nextRunAt = nextWakeupAt(task, now);
        if (!startup && (task.lastScheduledAt ?? 0) >= expectedDue!) {
          return undefined;
        }
        task.lastScheduledAt = expectedDue;
        if (startup) {
          task.lastStartupSessionId = task.startupSessionId;
        }
      }
      const run: WakeupRun = {
        id: randomUUID(),
        taskId,
        taskName: task.name,
        model: task.model,
        effort: task.effort,
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
        const key = createHash("sha256")
          .update(startup ? `${taskId}:startup:${task.startupSessionId}:${expectedDue}` : `${taskId}:${expectedDue}`)
          .digest("hex");
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
      return { task: { ...task, accountIds: [...executionTask.accountIds] }, run };
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, "EPERM");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
