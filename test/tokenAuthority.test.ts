import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type * as vscode from "vscode";
import type { CodexTokens } from "../src/core/types";

const { refresh, readAuth, writeAuth } = vi.hoisted(() => ({
  refresh: vi.fn(),
  readAuth: vi.fn(),
  writeAuth: vi.fn()
}));
vi.mock("../src/auth/oauth", async (original) => ({
  ...(await original<typeof import("../src/auth/oauth")>()),
  refreshTokens: refresh
}));
vi.mock("../src/codex", async (original) => ({
  ...(await original<typeof import("../src/codex")>()),
  readAuthFile: readAuth,
  writeAuthFile: writeAuth
}));
vi.mock("../src/services/profile", () => ({ fetchRemoteAccountProfile: async () => undefined }));
import { AccountsRepository } from "../src/storage";
import { getAideckCodexAccountFilePath } from "../src/storage/aideckCodexStorage";

let directory: string;
let previousRoot: string | undefined;
let context: vscode.ExtensionContext;
let secrets: Map<string, string>;
const repositories: AccountsRepository[] = [];
function tokens(label: string, expired = false): CodexTokens {
  const payload = Buffer.from(
    JSON.stringify({
      email: "fixture@example.test",
      exp: Math.floor(Date.now() / 1000) + (expired ? -60 : 3_600),
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-fixture" }
    })
  ).toString("base64url");
  return {
    idToken: `header.${payload}.${label}`,
    accessToken: `header.${payload}.${label}`,
    refreshToken: `fixture-${label}`,
    accountId: "acct-fixture"
  };
}
function repository(): AccountsRepository {
  const repo = new AccountsRepository(context);
  repositories.push(repo);
  return repo;
}
function defer<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(async () => {
  vi.clearAllMocks();
  readAuth.mockResolvedValue(undefined);
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-token-authority-"));
  previousRoot = process.env.AIDECK_DATA_DIR;
  process.env.AIDECK_DATA_DIR = path.join(directory, "mirror");
  secrets = new Map([["codex.account.fixture", JSON.stringify(tokens("original", true))]]);
  context = {
    globalStorageUri: { fsPath: directory },
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => {
        secrets.set(key, value);
      },
      delete: async (key: string) => {
        secrets.delete(key);
      }
    }
  } as unknown as vscode.ExtensionContext;
  await fs.writeFile(
    path.join(directory, "accounts-index.json"),
    JSON.stringify({
      accounts: [
        {
          id: "fixture",
          email: "fixture@example.test",
          accountId: "acct-fixture",
          isActive: false,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
  );
});
afterEach(async () => {
  repositories.splice(0).forEach((repo) => repo.dispose());
  if (previousRoot === undefined) {
    delete process.env.AIDECK_DATA_DIR;
  } else {
    process.env.AIDECK_DATA_DIR = previousRoot;
  }
  await fs.rm(directory, { recursive: true, force: true });
});
describe("token authority", () => {
  it("rejects a stale token snapshot after newer credentials were saved", async () => {
    const repo = repository();
    const original = await repo.getTokens("fixture");
    const login = tokens("new-login");
    await repo.updateTokens("fixture", login);
    await repo.updateTokens("fixture", tokens("late-refresh"), original);
    expect(await repo.getTokens("fixture", { bypassCache: true, syncExternal: false })).toEqual(login);
  });
  it("rejects a stale quota result without rolling credentials back", async () => {
    const repo = repository();
    const original = await repo.getTokens("fixture");
    const login = tokens("new-login");
    await repo.updateTokens("fixture", login);
    await repo.updateQuota("fixture", undefined, undefined, tokens("late-refresh"), undefined, undefined, original);
    expect(await repo.getTokens("fixture", { bypassCache: true, syncExternal: false })).toEqual(login);
  });
  it("coalesces refreshes across independent repositories sharing storage", async () => {
    const renewed = tokens("renewed");
    refresh.mockResolvedValue(renewed);
    const results = await Promise.all(Array.from({ length: 4 }, () => repository().getFreshTokens("fixture")));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(results).toEqual([renewed, renewed, renewed, renewed]);
  });
  it("preserves a new login and its mirror when an old refresh completes later", async () => {
    const pending = defer<CodexTokens>();
    refresh.mockReturnValue(pending.promise);
    const owner = repository();
    const running = owner.getFreshTokens("fixture");
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    const login = tokens("new-login");
    await repository().updateTokens("fixture", login);
    pending.resolve(tokens("late-refresh"));
    expect(await running).toEqual(login);
    const mirror = JSON.parse(await fs.readFile(getAideckCodexAccountFilePath("fixture"), "utf8"));
    expect(mirror.tokens.refresh_token).toBe(login.refreshToken);
  });
  it("does not report an old refresh error against a newer valid login", async () => {
    const pending = defer<CodexTokens>();
    refresh.mockReturnValue(pending.promise);
    const running = repository().getFreshTokens("fixture");
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    const login = tokens("new-login");
    await repository().updateTokens("fixture", login);
    pending.reject(new Error("invalid_grant from the old request"));
    expect(await running).toEqual(login);
  });
  it("reuses a newer credential snapshot for concurrent stale 401 responses", async () => {
    const original = tokens("original");
    secrets.set("codex.account.fixture", JSON.stringify(original));
    const renewed = tokens("renewed");
    refresh.mockResolvedValue(renewed);
    const results = await Promise.all(
      [repository(), repository()].map((repo) =>
        repo.getFreshTokens("fixture", { force: true, expectedTokens: original })
      )
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(results).toEqual([renewed, renewed]);
  });
  it("does not restore deleted credentials when a refresh completes", async () => {
    const pending = defer<CodexTokens>();
    refresh.mockReturnValue(pending.promise);
    const running = repository().getFreshTokens("fixture");
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await repository().removeAccount("fixture");
    pending.resolve(tokens("late-refresh"));
    await running.catch(() => undefined);
    expect(secrets.has("codex.account.fixture")).toBe(false);
  });
});
