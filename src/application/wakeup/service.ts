import { watch, type FSWatcher } from "fs";
import * as fs from "fs/promises";
import type { AccountsRepository } from "../../storage";
import type { WakeupSnapshot, WakeupTask, WakeupTaskInput } from "../../domain/wakeup/types";
import { WakeupStore } from "../../storage/wakeupStore";
import { validateWakeupTask } from "../../domain/wakeup/schedule";

type ActiveRun = { task: WakeupTask; trigger: "manual" | "scheduled"; controller: AbortController };

export class WakeupService {
  private timer?: NodeJS.Timeout;
  private watcher?: FSWatcher;
  private disposed = false;
  private polling = false;
  private readonly active = new Map<string, ActiveRun>();
  private lastSnapshot = "";

  constructor(
    readonly store: WakeupStore,
    private readonly repo: Pick<AccountsRepository, "getAccount">,
    private readonly execute: (accountId: string, task: WakeupTask, signal: AbortSignal) => Promise<void>,
    private readonly onChange: () => void,
    private readonly now: () => number = Date.now
  ) {}

  async start(): Promise<void> {
    await fs.mkdir(this.store.directory, { recursive: true, mode: 0o700 });
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
    for (const run of this.active.values()) {
      run.controller.abort();
    }
  }

  async snapshot(): Promise<WakeupSnapshot> {
    try {
      return await this.store.read();
    } catch (error) {
      return {
        version: 1,
        enabled: false,
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
    await this.checkCancellation();
    this.notify();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.store.setEnabled(enabled);
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
      throw new Error("This wakeup task is already running in another window or no longer exists");
    }
  }

  async poll(): Promise<void> {
    if (this.disposed || this.polling) {
      return;
    }
    this.polling = true;
    try {
      await this.checkCancellation();
      await this.store.recoverInterrupted(this.now());
      const state = await this.store.read();
      const serialized = JSON.stringify(state);
      if (serialized !== this.lastSnapshot) {
        this.lastSnapshot = serialized;
        this.notify();
      }
      if (!state.enabled) {
        return;
      }
      for (const task of state.tasks) {
        if (this.disposed) {
          break;
        }
        if (task.enabled && task.nextRunAt <= this.now()) {
          await this.run(task.id, "scheduled", task.nextRunAt);
        }
      }
    } finally {
      this.polling = false;
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
      const claim = await this.store.claim(id, trigger, due, this.now());
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
          try {
            if (!(await this.repo.getAccount(accountId))) {
              throw new Error("Account no longer exists");
            }
            await this.execute(accountId, claim.task, controller.signal);
            successes += 1;
            await this.store.addResult(claim.run.id, { accountId, status: "success" });
          } catch (error) {
            failures += 1;
            await this.store.addResult(claim.run.id, {
              accountId,
              status: controller.signal.aborted ? "cancelled" : "failed",
              message: safeMessage(error)
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
      if (
        task?.updatedAt !== run.task.updatedAt ||
        (run.trigger === "scheduled" && (!state.enabled || !task.enabled))
      ) {
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
  return message.replace(/Bearer\s+\S+|\beyJ[A-Za-z0-9._-]+|\bsk-[A-Za-z0-9_-]+/gi, "[redacted]").slice(0, 240);
}
