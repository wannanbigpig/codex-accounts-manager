import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { mirrorAideckCodexAccount, getAideckCodexAccountFilePath } from "../src/storage/aideckCodexStorage";

let directory: string;
let previousRoot: string | undefined;
const payload = Buffer.from(JSON.stringify({ email: "fixture@example.test" })).toString("base64url");
const tokens = {
  idToken: `header.${payload}.signature`,
  accessToken: `header.${payload}.signature`,
  refreshToken: "fixture-refresh"
};
const account = { id: "fixture", email: "fixture@example.test", createdAt: 1, updatedAt: 1, isActive: false };
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-mirror-security-"));
  previousRoot = process.env.AIDECK_DATA_DIR;
  process.env.AIDECK_DATA_DIR = directory;
});
afterEach(async () => {
  if (previousRoot === undefined) {
    delete process.env.AIDECK_DATA_DIR;
  } else {
    process.env.AIDECK_DATA_DIR = previousRoot;
  }
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});
describe("credential mirror boundary", () => {
  it("publishes credential files and their directory with private permissions", async () => {
    await mirrorAideckCodexAccount(account, tokens);
    const file = getAideckCodexAccountFilePath(account.id);
    if (process.platform !== "win32") {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    }
    expect(JSON.parse(await fs.readFile(file, "utf8")).tokens.access_token).toBe(tokens.accessToken);
    expect((await fs.readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
  it("tightens an existing credential file when publishing a new snapshot", async () => {
    const file = getAideckCodexAccountFilePath(account.id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{}", { mode: 0o644 });
    await mirrorAideckCodexAccount(account, tokens);
    if (process.platform !== "win32") {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    }
  });
  it("preserves credentials when the shared index is corrupt", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const file = getAideckCodexAccountFilePath(account.id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{}");
    const indexPath = path.join(path.dirname(path.dirname(file)), "accounts-index.json");
    await fs.writeFile(indexPath, "broken index");
    await mirrorAideckCodexAccount(account, tokens);
    expect(await fs.readFile(file, "utf8")).toBe("{}");
    expect(await fs.readFile(indexPath, "utf8")).toBe("broken index");
  });
  it.each(["broken json", JSON.stringify({ version: 1, algorithm: "AES-256-GCM", ciphertext: "fixture" })])(
    "preserves corrupt or unsupported storage instead of adding plaintext credentials",
    async (original) => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const file = getAideckCodexAccountFilePath(account.id);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, original);
      await mirrorAideckCodexAccount(account, tokens);
      expect(await fs.readFile(file, "utf8")).toBe(original);
    }
  );
});
