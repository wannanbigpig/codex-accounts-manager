import { watch, type FSWatcher } from "fs";
import * as fs from "fs/promises";
import type { AccountsRepository } from "../../storage";
import type { WakeupSnapshot, WakeupTask, WakeupTaskInput, WakeupExecutionResult } from "../../domain/wakeup/types";
import { sanitizeWakeupText, wakeupFailure } from "../../domain/wakeup/diagnostics";
import { WakeupStore } from "../../storage/wakeupStore";
import { validateWakeupTask } from "../../domain/wakeup/schedule";
import { createKeyedMutex } from "../../utils/concurrency";

type ActiveRun = { task: WakeupTask; trigger: "manual" | "scheduled"; controller: AbortController };

export class WakeupService {
  private timer?: NodeJS.Timeout;
  private watcher?: FSWatcher;
  private disposed = false;
  private polling = false;
  private readonly active = new Map<string, ActiveRun>();
  private readonly accountRequests = createKeyedMutex();
  private lastSnapshot = "";
  private releaseScheduler?: () => Promise<void>;

  constructor(
    readonly store: WakeupStore,
    private readonly repo: Pick<AccountsRepository, "getAccount">,
    private readonly execute: (
      accountId: string,
      task: WakeupTask,
      signal: AbortSignal
    ) => Promise<void | WakeupExecutionResult>,
    private readonly onChange: () => void,
    private readonly now: () => number = Date.now
  ) {}

  async start(): Promise<void> {
    if (this.disposed || this.releaseScheduler) {
      return;
    }
    await fs.mkdir(this.store.directory, { recursive: true, mode: 0o700 });
    const membership = await this.store.joinSchedulerSession(this.now(), () => this.dispose());
    if (this.disposed) {
      await membership.release();
      return;
    }
    this.releaseScheduler = membership.release;
    this.watcher = watch(this.store.directory, { persistent: false }, (_event, filename) => {
      if (filename?.toString() === "tasks.json") {
        void this.checkCancellation()
          .then(() => this.notify())
          .catch(() => this.notify());
      }
    });
    this.watcher.on("error", () => this.notify());
    this.timer = setInterval(() => {
      void this.poll().catch(() => this.notify());
    }, 15_000);
    this.timer.unref();
    void this.poll().catch(() => this.notify());
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.watcher?.close();
    void this.releaseScheduler?.().catch(() => undefined);
    this.releaseScheduler = undefined;
    for (const run of this.active.values()) {
      run.controller.abort();
    }
  }

  async snapshot(): Promise<WakeupSnapshot> {
    try {
      return await this.store.read();
    } catch (error) {
      return {
        version: 4,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        tasks: [],
        history: [],
        storageError: safeMessage(error)
      };
    }
  }

  async saveTask(input: WakeupTaskInput): Promise<void> {
    const valid = validateWakeupTask(input);
    for (const id of valid.accountIds) {
      if (!(await this.repo.getAccount(id))) {
        throw new Error("A selected account no longer exists");
      }
    }
    await this.store.saveTask(valid, this.now());
    if (valid.scheduleMode === "quota_reset") {
      await this.store.syncQuotaSchedules((id) => this.repo.getAccount(id));
    }
    await this.checkCancellation();
    this.notify();
  }

  async setTaskEnabled(id: string, enabled: boolean): Promise<void> {
    await this.store.setTaskEnabled(id, enabled, this.now());
    await this.checkCancellation();
    this.notify();
  }

  async removeTask(id: string): Promise<void> {
    await this.store.removeTask(id);
    await this.checkCancellation();
    this.notify();
  }

  async runNow(id: string): Promise<void> {
    if (this.disposed) {
      throw new Error("Wakeup scheduler has stopped");
    }
    if (!(await this.run(id, "manual"))) {
      throw new Error("This wakeup task is already running in another window or unavailable in this window");
    }
  }

  async poll(): Promise<void> {
    if (this.disposed || this.polling) {
      return;
    }
    this.polling = true;
    const runs: Promise<boolean>[] = [];
    try {
      await this.checkCancellation();
      await this.store.recoverInterrupted(this.now());
      await this.store.syncQuotaSchedules((id) => this.repo.getAccount(id));
      const state = await this.store.read();
      const serialized = JSON.stringify(state);
      if (serialized !== this.lastSnapshot) {
        this.lastSnapshot = serialized;
        this.notify();
      }
      for (const task of state.tasks) {
        if (this.disposed) {
          break;
        }
        if (task.enabled && !this.active.has(task.id) && task.nextRunAt > 0 && task.nextRunAt <= this.now()) {
          runs.push(this.run(task.id, "scheduled", task.nextRunAt));
        }
      }
    } finally {
      this.polling = false;
    }
    // Only the polling pass is exclusive; long requests must not block later polls or other tasks.
    const results = await Promise.allSettled(runs);
    for (const result of results) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
  }

  private async run(id: string, trigger: "manual" | "scheduled", due?: number): Promise<boolean> {
    const controller = new AbortController();
    const release = await this.store.tryRunLease(id, () => controller.abort());
    if (!release) {
      return false;
    }
    try {
      if (this.disposed) {
        return false;
      }
      const claim = await this.store.claim(id, trigger, due, this.now(), async (task) => {
        for (const accountId of task.accountIds) {
          if (!(await this.repo.getAccount(accountId))) {
            return false;
          }
        }
        return true;
      });
      if (!claim) {
        this.notify();
        return false;
      }
      this.active.set(id, { task: claim.task, trigger, controller });
      if (this.disposed) {
        controller.abort();
      }
      this.notify();
      let successes = 0;
      let failures = 0;
      try {
        for (const accountId of claim.task.accountIds) {
          await this.checkCancellation();
          if (controller.signal.aborted) {
            break;
          }
          let startedAt = this.now();
          try {
            const diagnostic = await this.accountRequests.runExclusive(accountId, async () => {
              startedAt = this.now();
              await this.checkCancellation();
              controller.signal.throwIfAborted();
              if (!(await this.repo.getAccount(accountId))) {
                throw new Error("Account no longer exists");
              }
              return this.execute(accountId, claim.task, controller.signal);
            });
            successes += 1;
            await this.store.addResult(claim.run.id, {
              accountId,
              status: "success",
              durationMs: Math.max(0, this.now() - startedAt),
              reply: diagnostic ? sanitizeWakeupText(diagnostic.reply) : undefined,
              model: diagnostic?.model ? sanitizeWakeupText(diagnostic.model, 120) : undefined,
              quotaWarning: diagnostic?.quotaWarning ? sanitizeWakeupText(diagnostic.quotaWarning, 240) : undefined
            });
          } catch (error) {
            failures += 1;
            await this.store.addResult(claim.run.id, {
              accountId,
              status: controller.signal.aborted ? "cancelled" : "failed",
              message: safeMessage(error),
              durationMs: Math.max(0, this.now() - startedAt),
              ...wakeupFailure(error),
              ...(controller.signal.aborted ? { errorStage: "cancelled" as const } : {})
            });
          }
          this.notify();
        }
      } finally {
        try {
          await this.store.finish(
            claim.run.id,
            controller.signal.aborted ? "cancelled" : failures ? (successes ? "partial" : "failed") : "success",
            this.now()
          );
        } finally {
          this.active.delete(id);
          this.notify();
        }
      }
      return true;
    } finally {
      await release();
    }
  }

  private async checkCancellation(): Promise<void> {
    if (!this.active.size) {
      return;
    }
    const state = await this.store.read();
    for (const [id, run] of this.active) {
      const task = state.tasks.find((item) => item.id === id);
      if (task?.updatedAt !== run.task.updatedAt || (run.trigger === "scheduled" && !task.enabled)) {
        run.controller.abort();
      }
    }
  }

  private notify(): void {
    if (!this.disposed) {
      this.onChange();
    }
  }
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Wakeup request failed";
  return sanitizeWakeupText(message, 240);
}
