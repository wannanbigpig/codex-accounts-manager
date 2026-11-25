import { constants, promises as fs, type Stats } from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { getCodexHome } from "../codex";

const HISTORY_MS = 30 * 86_400_000;
const MAX_FILES = 400;
const MAX_ROWS = 5_000;
const MAX_FILE_ROWS = 1_000;
const MAX_LINE_BYTES = 8 * 1024 * 1024;

type TokenUsage = { input: number; cached: number; output: number };
type UsageRow = TokenUsage & { timestamp: number; model: string; project: string; key: string };
export type LocalSessionUsage = { rows: Omit<UsageRow, "key">[]; limited: boolean };
type FileCheckpoint = {
  inode: number;
  size: number;
  modified: number;
  offset: number;
  anchor?: string;
  discardingLine: boolean;
  limited?: boolean;
  continuation?: boolean;
  session: string;
  project: string;
  model: string;
  previous?: TokenUsage;
  rows: UsageRow[];
};

export class LocalSessionUsageReader {
  private readonly checkpoints = new Map<string, FileCheckpoint>();
  private inFlight?: { root: string; report: Promise<LocalSessionUsage> };

  read(root = getCodexHome(), now = Date.now()): Promise<LocalSessionUsage> {
    const current = this.inFlight;
    if (current) {
      return current.root === root
        ? current.report
        : current.report.then(
            () => this.read(root, now),
            () => this.read(root, now)
          );
    }
    const report = this.scan(root, now).finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = { root, report };
    return report;
  }

  private async scan(root: string, now: number): Promise<LocalSessionUsage> {
    const cutoff = now - HISTORY_MS;
    const files: Array<{ name: string; stat: Stats }> = [];
    for (const directory of ["sessions", "archived_sessions"]) {
      const folder = path.join(root, directory);
      const rootStat = await fs.lstat(folder).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
        return undefined;
      });
      if (rootStat?.isDirectory()) {
        await findUsageFiles(folder, 0, cutoff, files);
      }
    }
    files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || a.name.localeCompare(b.name));
    const selected = files.slice(0, MAX_FILES);
    const currentFiles = new Set(selected.map((file) => file.name));
    for (const name of this.checkpoints.keys()) {
      if (!currentFiles.has(name)) {
        this.checkpoints.delete(name);
      }
    }

    let limited = files.length > MAX_FILES;
    const unique = new Map<string, UsageRow>();
    for (const { name, stat } of selected) {
      const prior = this.checkpoints.get(name);
      let next = prior;
      try {
        if (prior?.modified !== stat.mtimeMs || prior.size !== stat.size || prior.inode !== stat.ino) {
          next = await readUsageFile(name, stat, prior, cutoff);
          if (next) {
            this.checkpoints.set(name, next);
          }
        }
      } catch {
        limited = true;
        continue;
      }
      if (!next) {
        limited = true;
        continue;
      }
      limited ||= next.limited === true;
      for (const row of next.rows) {
        if (row.timestamp >= cutoff && row.timestamp <= now) {
          unique.set(row.key, row);
        }
      }
    }
    const ordered = [...unique.values()].sort((a, b) => b.timestamp - a.timestamp || a.key.localeCompare(b.key));
    return {
      rows: ordered.slice(0, MAX_ROWS).map(({ key: _key, ...row }) => row),
      limited: limited || ordered.length > MAX_ROWS
    };
  }
}

async function findUsageFiles(
  folder: string,
  depth: number,
  cutoff: number,
  files: Array<{ name: string; stat: Stats }>
): Promise<void> {
  const entries = await fs.readdir(folder, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return [];
  });
  for (const entry of entries) {
    const name = path.join(folder, entry.name);
    if (entry.isDirectory() && depth < 3) {
      await findUsageFiles(name, depth + 1, cutoff, files);
    } else if (entry.isFile() && /\.jsonl(?:\.(?:gz|zst))?$/.test(entry.name)) {
      const stat = await fs.lstat(name).catch(() => undefined);
      if (stat?.isFile() && stat.mtimeMs >= cutoff) {
        files.push({ name, stat });
      }
    }
  }
}

async function readUsageFile(
  name: string,
  stat: Stats,
  prior: FileCheckpoint | undefined,
  cutoff: number
): Promise<FileCheckpoint | undefined> {
  const compressed = !name.endsWith(".jsonl");
  const createZstd = (zlib as typeof zlib & { createZstdDecompress?: () => zlib.Gunzip }).createZstdDecompress;
  if (name.endsWith(".zst") && !createZstd) {
    return undefined;
  }
  const append =
    !compressed &&
    prior?.inode === stat.ino &&
    stat.size > prior.size &&
    prior.anchor === (await readUsageAnchor(name, prior.offset));
  const next: FileCheckpoint = append
    ? { ...prior, rows: prior.rows.filter((row) => row.timestamp >= cutoff) }
    : {
        inode: stat.ino,
        modified: stat.mtimeMs,
        size: 0,
        offset: 0,
        discardingLine: false,
        session: name,
        project: "",
        model: "",
        rows: []
      };
  if (!stat.size) {
    return next;
  }
  const file = await fs.open(name, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const input = file.createReadStream(compressed ? {} : { start: next.offset, end: stat.size - 1 });
  const decoder = compressed ? (name.endsWith(".gz") ? zlib.createGunzip() : createZstd?.()) : undefined;
  if (decoder) {
    input.on("error", (error) => decoder.destroy(error));
  }
  const stream = decoder ? input.pipe(decoder) : input;
  let fragments: Buffer[] = [];
  let bytes = 0;
  let position = next.offset;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline === -1 ? chunk.length : newline;
        const part = chunk.subarray(start, end);
        bytes += part.length;
        if (bytes > MAX_LINE_BYTES) {
          next.discardingLine = true;
          next.limited = true;
          fragments = [];
        }
        if (!next.discardingLine) {
          fragments.push(part);
        }
        const consumed = end - start + Number(newline !== -1);
        position += consumed;
        if (newline !== -1) {
          if (!next.discardingLine) {
            readUsageLine(Buffer.concat(fragments).toString("utf8"), next, cutoff);
          }
          fragments = [];
          bytes = 0;
          next.discardingLine = false;
          next.offset = position;
        } else if (next.discardingLine) {
          next.offset = position;
        }
        start += consumed;
      }
    }
    if (compressed && fragments.length) {
      readUsageLine(Buffer.concat(fragments).toString("utf8"), next, cutoff);
    }
  } finally {
    input.destroy();
  }
  next.modified = stat.mtimeMs;
  next.size = stat.size;
  if (!compressed) {
    next.anchor = await readUsageAnchor(name, next.offset);
  }
  return next;
}

async function readUsageAnchor(name: string, offset: number): Promise<string | undefined> {
  if (!offset) {
    return undefined;
  }
  const file = await fs.open(name, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const bytes = Buffer.alloc(Math.min(offset, 64));
    await file.read(bytes, 0, bytes.length, offset - bytes.length);
    return bytes.toString("base64");
  } finally {
    await file.close();
  }
}

function readUsageLine(line: string, state: FileCheckpoint, cutoff: number): void {
  if (!/"(?:session_meta|turn_context|token_count)"/.test(line)) {
    return;
  }
  let event: Record<string, unknown> | undefined;
  try {
    event = asRecord(JSON.parse(line));
  } catch {
    return;
  }
  const payload = asRecord(event?.["payload"]);
  if (!payload) {
    return;
  }
  if (event?.["type"] === "session_meta" || event?.["type"] === "turn_context") {
    state.project = readLabel(payload["cwd"]) ?? state.project;
    state.model = readLabel(payload["model"]) ?? readLabel(asRecord(payload["info"])?.["model"]) ?? state.model;
    if (event["type"] === "session_meta") {
      state.session = readLabel(payload["id"]) ?? state.session;
      state.continuation = payload["history_mode"] === "paginated" || Boolean(payload["parent_thread_id"]);
    }
    return;
  }
  if (event?.["type"] !== "event_msg" || payload["type"] !== "token_count") {
    return;
  }
  const info = asRecord(payload["info"]);
  state.model =
    readLabel(info?.["model"]) ?? readLabel(info?.["model_name"]) ?? readLabel(payload["model"]) ?? state.model;
  const total = readTokens(info?.["total_token_usage"]);
  const last = readTokens(info?.["last_token_usage"]);
  const previous = state.previous;
  if (total) {
    state.previous = total;
  }
  const delta =
    total && previous
      ? {
          input: total.input - previous.input,
          cached: total.cached - previous.cached,
          output: total.output - previous.output
        }
      : undefined;
  if (delta && Object.values(delta).every((n) => n === 0)) {
    return;
  }
  const usage =
    last ??
    (delta && Object.values(delta).every((n) => n >= 0) ? delta : undefined) ??
    (!previous && !state.continuation ? total : undefined);
  const timestamp = typeof event["timestamp"] === "string" ? Date.parse(event["timestamp"]) : NaN;
  if (!usage || !Number.isFinite(timestamp) || timestamp < cutoff || !(usage.input || usage.output || usage.cached)) {
    return;
  }
  const key = JSON.stringify([state.session, timestamp, state.model, total ?? usage]);
  state.rows.push({
    ...usage,
    cached: Math.min(usage.cached, usage.input),
    timestamp,
    model: state.model,
    project: state.project,
    key
  });
  if (state.rows.length > MAX_FILE_ROWS * 2) {
    state.rows.splice(0, MAX_FILE_ROWS);
    state.limited = true;
  }
}

function readLabel(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 1024) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readTokens(value: unknown): TokenUsage | undefined {
  const record = asRecord(value);
  const count = (key: string) => {
    const n = record?.[key];
    return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  };
  const input = count("input_tokens");
  const output = count("output_tokens");
  return input === undefined && output === undefined
    ? undefined
    : { input: input ?? 0, output: output ?? 0, cached: count("cached_input_tokens") ?? 0 };
}
