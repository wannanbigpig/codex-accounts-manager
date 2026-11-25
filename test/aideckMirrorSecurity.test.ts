import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  getAideckCodexAccountFilePath,
  listAideckCodexSharedAccounts,
  mirrorAideckCodexAccount,
  mirrorAideckCurrentAccount,
  readAideckCodexSharedAccount,
  removeAideckCodexAccount
} from "../src/storage/aideckCodexStorage";

const { beforeRemove, onLockAttempt } = vi.hoisted(() => ({
  beforeRemove: vi.fn<(file: unknown) => void | Promise<void>>(),
  onLockAttempt: vi.fn<(key: string) => void>()
}));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      await beforeRemove(args[0]);
      return actual.rm(...args);
    }
  };
});

vi.mock("../src/storage/credentialLocks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/storage/credentialLocks")>();
  return {
    ...actual,
    withCredentialLock<T>(directory: string, key: string, operation: (assertHeld: () => void) => Promise<T>) {
      onLockAttempt(key);
      return actual.withCredentialLock(directory, key, operation);
    }
  };
});

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
  beforeRemove.mockReset();
  onLockAttempt.mockReset();
  if (previousRoot === undefined) {
    delete process.env.AIDECK_DATA_DIR;
  } else {
    process.env.AIDECK_DATA_DIR = previousRoot;
  }
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

function gate() {
  let open!: () => void;
  const ready = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { ready, open };
}

describe("credential mirror boundary", () => {
  it("keeps the newly selected account when another window was deleting the former account", async () => {
    await mirrorAideckCurrentAccount("former");
    const removingCurrent = gate();
    const resumeRemoval = gate();
    beforeRemove.mockImplementation(async (file) => {
      if (typeof file === "string" && path.basename(file) === "current.json") {
        removingCurrent.open();
        await resumeRemoval.ready;
      }
    });
    const removing = removeAideckCodexAccount("former");
    await removingCurrent.ready;

    const switchQueued = gate();
    onLockAttempt.mockImplementation((key) => {
      if (key === "current.json") {
        switchQueued.open();
      }
    });
    const switching = mirrorAideckCurrentAccount("next");
    try {
      // Before the fix the switch completes while deletion is still paused. With the lock it queues.
      await Promise.race([switchQueued.ready, switching]);
    } finally {
      resumeRemoval.open();
      await Promise.all([removing, switching]);
    }

    const currentPath = path.join(directory, "accounts", "codex", "current.json");
    expect(JSON.parse(await fs.readFile(currentPath, "utf8"))).toMatchObject({ id: "next" });
  });

  it("keeps a deleted record out of the shared index when another window publishes its account", async () => {
    const former = { ...account, id: "former" };
    const next = { ...account, id: "next" };
    await mirrorAideckCodexAccount(former, tokens);
    const atPublish = gate();
    const resumePublish = gate();
    const rename = fs.rename;
    let paused = false;
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (!paused && typeof destination === "string" && path.basename(destination) === "accounts-index.json") {
        paused = true;
        atPublish.open();
        await resumePublish.ready;
      }
      return rename(source, destination);
    });

    const publishing = mirrorAideckCodexAccount(next, tokens);
    await atPublish.ready;
    const deletionQueued = gate();
    onLockAttempt.mockImplementation((key) => {
      if (key === "accounts-index.json") {
        deletionQueued.open();
      }
    });
    const removing = removeAideckCodexAccount(former.id);
    try {
      await Promise.race([deletionQueued.ready, removing]);
    } finally {
      resumePublish.open();
      await Promise.all([publishing, removing]);
    }

    const indexPath = path.join(directory, "accounts", "codex", "accounts-index.json");
    const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
    expect(index.accounts).toMatchObject([{ id: next.id }]);
    expect(await readAideckCodexSharedAccount(former.id)).toBeUndefined();
    expect(await readAideckCodexSharedAccount(next.id)).toMatchObject({ id: next.id });
  });

  it("re-reads a discovered account by its actual filename regardless of its record id", async () => {
    const accountsDir = path.dirname(getAideckCodexAccountFilePath(account.id));
    const sourceId = "legacy account";
    await fs.mkdir(accountsDir, { recursive: true });
    await fs.writeFile(
      path.join(accountsDir, `${sourceId}.json`),
      JSON.stringify({
        id: "different-id",
        email: account.email,
        tokens: { id_token: tokens.idToken, access_token: tokens.accessToken }
      })
    );

    const candidates = await listAideckCodexSharedAccounts();
    expect(candidates).toMatchObject([{ sourceId, entry: { id: "different-id" } }]);
    expect(await readAideckCodexSharedAccount(sourceId)).toEqual(candidates[0]?.entry);
  });

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
