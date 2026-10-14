import { afterEach, describe, expect, it } from "vitest";
import { fork, type ChildProcess } from "child_process";
import { createServer, type Server } from "http";
import { once } from "events";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { WakeupStore } from "../src/storage/wakeupStore";
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
const children: ChildProcess[] = [];
let directory: string;
let server: Server | undefined;
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill();
    }
  }
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  if (directory) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
async function setup(
  scheduleMode: "calendar" | "interval" = "calendar"
): Promise<{ store: WakeupStore; endpoint: string; requests: string[]; due: number }> {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-wakeup-process-"));
  const store = new WakeupStore(directory);
  const task = await store.saveTask(
    { ...input, scheduleMode, intervalMinutes: 300 },
    new Date(2026, 9, 8, 6, 0).getTime()
  );
  await store.setEnabled(true);
  const requests: string[] = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      requests.push(body);
      res.end("OK");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    store,
    requests,
    due: task.nextRunAt,
    endpoint: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`
  };
}
async function worker(): Promise<ChildProcess> {
  const child = fork(path.resolve("test/fixtures/wakeupProcess.cjs"), { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.push(child);
  let errors = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    child.once("message", () => resolve());
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code) {
        reject(new Error(`worker exited ${code}: ${errors}`));
      }
    });
  });
  return child;
}
function run(child: ChildProcess, endpoint: string, now: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.once("message", (message: { error?: string }) =>
      message.error ? reject(new Error(message.error)) : resolve()
    );
    child.once("error", reject);
    child.send({ directory, endpoint, now });
  });
}

describe("multiple independent VS Code hosts", () => {
  it.each(["calendar", "interval"] as const)(
    "dispatches one %s occurrence across four processes and does not replay it after restart",
    async (mode) => {
      const { store, endpoint, requests, due } = await setup(mode);
      const windows = await Promise.all(Array.from({ length: 4 }, () => worker()));
      await Promise.all(windows.map((child) => run(child, endpoint, due)));
      expect(requests).toEqual(["a", "b"]);
      expect((await store.read()).history).toHaveLength(1);
      expect((await store.read()).history[0]?.status).toBe("success");
      const restarted = await Promise.all([worker(), worker()]);
      await Promise.all(restarted.map((child) => run(child, endpoint, due + 1000)));
      expect(requests).toEqual(["a", "b"]);
    },
    20_000
  );
  it.each(["calendar", "interval"] as const)(
    "does not replay a partially sent %s occurrence after a host crashes",
    async (mode) => {
      const { store, endpoint, requests, due } = await setup(mode);
      const child = await worker();
      const exit = once(child, "exit");
      child.send({ directory, endpoint, now: due, crash: true });
      await exit;
      expect(requests).toEqual(["a"]);
      // Expire the dead process's lease without waiting a minute in this test.
      for (const name of await fs.readdir(directory)) {
        if (name.startsWith("run-") && name.endsWith(".lock")) {
          await fs.utimes(path.join(directory, name), new Date(0), new Date(0));
        }
      }
      await run(await worker(), endpoint, due + 1000);
      expect(requests).toEqual(["a"]);
      expect((await store.read()).history[0]?.status).toBe("interrupted");
    },
    20_000
  );
});
