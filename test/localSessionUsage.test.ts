import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { LocalSessionUsageReader } from "../src/services/localSessionUsage";

it("reads plain and compressed usage, resumes a partial line, and ignores conversation content and duplicate snapshots", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-session-usage-"));
  const now = Date.now();
  const event = (type: string, payload: object, age: number) => JSON.stringify({ type, payload, timestamp: new Date(now - age).toISOString() });
  const sample = (input: number, output: number, age: number) => event("event_msg", { type: "token_count", info: {
    total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: 0 }
  } }, age);
  const root = path.join(home, "sessions", "2026", "11", "25");
  const archived = path.join(home, "archived_sessions");
  const file = path.join(root, "rollout.jsonl");
  const first = [event("session_meta", { id: "session-a", cwd: "/project-a" }, 5000),
    event("turn_context", { model: "model-a" }, 4500),
    event("response_item", { text: "private conversation" }, 4200), sample(10, 5, 4000), sample(10, 5, 3000)];
  const appended = sample(16, 7, 1000);
  try {
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(archived);
    await fs.writeFile(file, first.join("\n") + "\n" + appended.slice(0, 10));
    await fs.writeFile(path.join(archived, "rollout-copy.jsonl.gz"), gzipSync(first.join("\n")));
    await fs.writeFile(path.join(archived, "rollout-b.jsonl.gz"), gzipSync([
      event("session_meta", { id: "session-b", cwd: "/project-b", model: "model-b" }, 4000), sample(4, 3, 2500)
    ].join("\n")));
    const reader = new LocalSessionUsageReader();
    expect(await reader.read(home, now)).toEqual({ limited: false, rows: [
      { timestamp: now - 2500, model: "model-b", project: "/project-b", input: 4, output: 3, cached: 0 },
      { timestamp: now - 4000, model: "model-a", project: "/project-a", input: 10, output: 5, cached: 0 }
    ] });
    await fs.appendFile(file, appended.slice(10) + "\n");
    const updated = await reader.read(home, now);
    expect(updated.rows[0]).toEqual({ timestamp: now - 1000, model: "model-a", project: "/project-a", input: 6, output: 2, cached: 0 });
    expect(updated.rows).toHaveLength(3);
    expect(JSON.stringify(updated)).not.toContain("private conversation");
    expect(await reader.read(home, now)).toEqual(updated);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
