import { afterEach, describe, expect, it } from "vitest";
import { fork, type ChildProcess } from "child_process";
import { createServer, type Server } from "http";
import { once } from "events";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { WakeupStore } from "../src/storage/wakeupStore";
const children: ChildProcess[] = [];
let directory: string;
let server: Server | undefined;
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
  }
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});
async function worker(): Promise<ChildProcess> {
  const child = fork(path.resolve("test/fixtures/wakeupEventProcess.cjs"), {
    stdio: ["ignore", "ignore", "pipe", "ipc"]
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once("message", () => resolve());
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code) reject(new Error(`worker exited ${code}`));
    });
  });
  return child;
}
function command(child: ChildProcess, input: Record<string, unknown>): Promise<{ sessionId?: string }> {
  return new Promise((resolve, reject) => {
    child.once("message", (result: { error?: string; sessionId?: string }) =>
      result.error ? reject(new Error(result.error)) : resolve(result)
    );
    child.once("error", reject);
    child.send(input);
  });
}
describe("startup across independent extension hosts", () => {
  it("dispatches once per shared startup, including a restart at the same timestamp", async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-startup-hosts-"));
    const store = new WakeupStore(directory);
    const now = new Date(2026, 9, 14, 6, 0).getTime();
    await store.saveTask(
      {
        name: "Startup",
        enabled: true,
        accountIds: ["a", "b"],
        time: "",
        days: [],
        scheduleMode: "startup",
        startupDelayMinutes: 0,
        model: "gpt-5.6-luna",
        effort: "low",
        prompt: "Reply with OK."
      },
      now - 1000
    );
    const requests: string[] = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        requests.push(body);
        res.end("OK");
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    const endpoint = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const first = await Promise.all(Array.from({ length: 4 }, () => worker()));
    const results = await Promise.all(first.map((child) => command(child, { directory, now, endpoint })));
    expect(new Set(results.map((result) => result.sessionId)).size).toBe(1);
    expect(requests).toEqual(["a", "b"]);
    await Promise.all(first.map((child) => command(child, { stop: true })));
    const second = await Promise.all([worker(), worker()]);
    const restarted = await Promise.all(second.map((child) => command(child, { directory, now, endpoint })));
    expect(restarted[0]!.sessionId).not.toBe(results[0]!.sessionId);
    expect(requests).toEqual(["a", "b", "a", "b"]);
    expect((await store.read()).history.map((run) => run.status)).toEqual(["success", "success"]);
    await Promise.all(second.map((child) => command(child, { stop: true })));
  }, 20_000);
});
