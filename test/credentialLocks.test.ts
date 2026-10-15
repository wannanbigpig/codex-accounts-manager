import { afterEach, describe, expect, it } from "vitest";
import { fork, type ChildProcess } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
const children: ChildProcess[] = [];
let directory: string;
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill();
    }
  }
  if (directory) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
describe("credential file leases", () => {
  it("protects the same credential refresh across four independent hosts", async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-credential-hosts-"));
    const statePath = path.join(directory, "counter.json");
    await fs.writeFile(statePath, "0");
    const workers = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const child = fork(path.resolve("test/fixtures/credentialLockProcess.cjs"), {
          stdio: ["ignore", "ignore", "pipe", "ipc"]
        });
        children.push(child);
        await new Promise<void>((resolve, reject) => {
          child.once("message", () => resolve());
          child.once("error", reject);
          child.once("exit", (code) => reject(new Error(`worker exited ${code}`)));
        });
        return child;
      })
    );
    await Promise.all(
      workers.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            child.once("message", (message: { error?: string }) =>
              message.error ? reject(new Error(message.error)) : resolve()
            );
            child.once("error", reject);
            child.send({ directory: path.join(directory, "leases"), statePath });
          })
      )
    );
    expect(JSON.parse(await fs.readFile(statePath, "utf8"))).toBe(4);
    expect(await fs.readdir(path.join(directory, "leases"))).toEqual([]);
  }, 20_000);
});
