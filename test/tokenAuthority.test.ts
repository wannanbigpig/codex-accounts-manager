import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type * as vscode from "vscode";
import type { CodexAuthFile, CodexTokens } from "../src/core/types";
import { buildAccountStorageId } from "../src/utils/accountIdentity";

const fixtureHome = vi.hoisted(() => vi.fn<() => string | undefined>());
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => fixtureHome() ?? actual.homedir() };
});

const { refresh, readAuth, writeAuth, authPath } = vi.hoisted(() => ({
  refresh: vi.fn(),
  readAuth: vi.fn(),
  writeAuth: vi.fn(),
  authPath: vi.fn()
}));
const lockRequested = vi.hoisted(() => vi.fn<(key: string) => void>());
const afterMirrorSnapshot = vi.hoisted(() => vi.fn<(entryCount: number) => Promise<void>>());
vi.mock("../src/storage/aideckCodexStorage", async (original) => {
  const actual = await original<typeof import("../src/storage/aideckCodexStorage")>();
  return {
    ...actual,
    listAideckCodexSharedAccounts: async () => {
      const entries = await actual.listAideckCodexSharedAccounts();
      await afterMirrorSnapshot(entries.length);
      return entries;
    }
  };
});
vi.mock("../src/storage/credentialLocks", async (original) => {
  const actual = await original<typeof import("../src/storage/credentialLocks")>();
  const withCredentialLock: typeof actual.withCredentialLock = (lockDirectory, key, operation) => {
    lockRequested(key);
    return actual.withCredentialLock(lockDirectory, key, operation);
  };
  return { ...actual, withCredentialLock };
});
vi.mock("../src/auth/oauth", async (original) => ({
  ...(await original<typeof import("../src/auth/oauth")>()),
  refreshTokens: refresh
}));
vi.mock("../src/codex", async (original) => ({
  ...(await original<typeof import("../src/codex")>()),
  getAuthJsonPath: authPath,
  readAuthFile: readAuth,
  writeAuthFile: writeAuth
}));
vi.mock("../src/services/profile", () => ({ fetchRemoteAccountProfile: async () => undefined }));
import { AccountsRepository } from "../src/storage";
import { getAideckCodexAccountFilePath, mirrorAideckCodexAccount } from "../src/storage/aideckCodexStorage";
import { refreshSingleQuota } from "../src/application/accounts/quota";
import { readQuotaHistory } from "../src/domain/quotaHistory";
import { QUOTA_USAGE_URL, RESET_CREDITS_URL } from "../src/infrastructure/config/apiEndpoints";

let directory: string;
let previousRoot: string | undefined;
let context: vscode.ExtensionContext;
let secrets: Map<string, string>;
const repositories: AccountsRepository[] = [];
function tokens(label: string, expired = false, account = "fixture", issuedAt?: number): CodexTokens {
  const payload = Buffer.from(
    JSON.stringify({
      email: `${account}@example.test`,
      iat: issuedAt,
      exp: Math.floor(Date.now() / 1000) + (expired ? -60 : 3_600),
      "https://api.openai.com/auth": { chatgpt_account_id: `acct-${account}` }
    })
  ).toString("base64url");
  return {
    idToken: `header.${payload}.${label}`,
    accessToken: `header.${payload}.${label}`,
    refreshToken: `fixture-${label}`,
    accountId: `acct-${account}`
  };
}
function repository(profile = context): AccountsRepository {
  const repo = new AccountsRepository(profile);
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
function pauseCredentialRead() {
  const entered = defer<void>();
  const resume = defer<void>();
  const repo = repository({
    ...context,
    secrets: {
      ...context.secrets,
      get: async (key) => {
        entered.resolve();
        await resume.promise;
        return secrets.get(key);
      }
    }
  });
  return { repo, entered: entered.promise, resume: resume.resolve };
}

function pauseAfterSecretDeletion() {
  const deleted = defer<void>();
  const resume = defer<void>();
  const repo = repository({
    ...context,
    secrets: {
      ...context.secrets,
      delete: async (key) => {
        secrets.delete(key);
        deleted.resolve();
        await resume.promise;
      }
    }
  });
  return { repo, deleted: deleted.promise, resume: resume.resolve };
}

async function seedAccountForTokens(credentials: CodexTokens) {
  const saved = (await repository().getAccount("fixture"))!;
  const account = { ...saved, id: buildAccountStorageId(saved.email, credentials.accountId, undefined) };
  await fs.writeFile(
    path.join(directory, "accounts-index.json"),
    JSON.stringify({ currentAccountId: account.id, accounts: [account] })
  );
  secrets.set(`codex.account.${account.id}`, JSON.stringify(credentials));
  return account;
}

function authForTokens(credentials: CodexTokens): CodexAuthFile {
  return {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: credentials.idToken,
      access_token: credentials.accessToken,
      refresh_token: credentials.refreshToken,
      account_id: credentials.accountId
    }
  };
}

function mockPersistedAuth(credentials: CodexTokens): () => CodexAuthFile {
  let disk = authForTokens(credentials);
  readAuth.mockImplementation(async () => disk);
  writeAuth.mockImplementation(async (next: CodexTokens) => {
    disk = authForTokens(next);
  });
  return () => disk;
}

beforeEach(async () => {
  vi.clearAllMocks();
  afterMirrorSnapshot.mockReset();
  readAuth.mockResolvedValue(undefined);
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-token-authority-"));
  fixtureHome.mockReturnValue(directory);
  authPath.mockReturnValue(path.join(directory, "auth.json"));
  writeAuth.mockResolvedValue(undefined);
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
      currentAccountId: "fixture",
      accounts: [
        {
          id: "fixture",
          email: "fixture@example.test",
          accountId: "acct-fixture",
          isActive: true,
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: "backup",
          email: "backup@example.test",
          accountId: "acct-backup",
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
  it("reports an empty quota refresh as failed and retains the last valid stored snapshot", async () => {
    secrets.set("codex.account.fixture", JSON.stringify(tokens("quota-validation")));
    const owner = repository();
    await owner.updateQuota("fixture", {
      hourlyPercentage: 70, hourlyWindowPresent: true, hourlyWindowMinutes: 300,
      weeklyPercentage: 85, weeklyWindowPresent: true, weeklyWindowMinutes: 10_080
    });
    vi.spyOn(owner, "refreshSubscriptionState").mockResolvedValue(undefined);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      expect(String(url)).toBe(QUOTA_USAGE_URL);
      return Response.json({ rate_limit: {} });
    });

    try {
      await expect(refreshSingleQuota(owner, { refresh: vi.fn() }, "fixture", {
        announce: false, warnQuota: false, forceRefresh: true
      })).resolves.toBe(false);
      const saved = await owner.getAccount("fixture");
      expect(saved?.quotaError?.message).toBe("Invalid quota response");
      expect(saved?.quotaSummary).toMatchObject({ hourlyPercentage: 70, weeklyPercentage: 85 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("persists quota history from a successful refresh and keeps it unchanged on invalid responses", async () => {
    const credential = tokens("quota-history");
    secrets.set("codex.account.fixture", JSON.stringify(credential));
    const owner = repository();
    vi.spyOn(owner, "refreshSubscriptionState").mockResolvedValue(undefined);
    vi.spyOn(owner, "refreshResetCreditInventory").mockResolvedValue(undefined);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      expect(String(url)).toBe(QUOTA_USAGE_URL);
      return fetchMock.mock.calls.length === 1
        ? Response.json({ rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 18000 } } })
        : Response.json({ rate_limit: {} });
    });
    const refreshQuota = () => refreshSingleQuota(owner, { refresh: vi.fn() }, "fixture", {
      announce: false, warnQuota: false, forceRefresh: true
    });

    try {
      await expect(refreshQuota()).resolves.toBe(true);
      const first = (await repository().getAccount("fixture"))!;
      expect(readQuotaHistory(first, credential)).toEqual([{
        at: expect.any(Number), hourly: expect.objectContaining({ remaining: 0 }), weekly: undefined
      }]);
      expect((await owner.getAccount("backup"))?.quotaHistory).toBeUndefined();

      await expect(refreshQuota()).resolves.toBe(false);
      const latest = await repository().getAccount("fixture");
      expect(latest?.quotaError?.message).toBe("Invalid quota response");
      expect(latest?.quotaHistory).toEqual(first.quotaHistory);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("skips a valid quota response if another repository replaced its credentials before the write", async () => {
    const original = tokens("quota-before");
    const replacement = tokens("quota-after");
    secrets.set("codex.account.fixture", JSON.stringify(original));
    const owner = repository();
    vi.spyOn(owner, "refreshSubscriptionState").mockResolvedValue(undefined);
    const request = defer<Response>();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => request.promise);
    const refreshing = refreshSingleQuota(owner, { refresh() {} }, "fixture", { announce: false, warnQuota: false, forceRefresh: true });
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await repository().updateTokens("fixture", replacement);
      request.resolve(Response.json({ rate_limit: { primary_window: { used_percent: 10 } } }));
      await expect(refreshing).resolves.toBe(false);
      const saved = await owner.getAccount("fixture");
      expect(saved?.quotaSummary).toBeUndefined();
      expect(saved?.quotaError).toBeUndefined();
      expect(await owner.getTokens("fixture", { syncExternal: false })).toEqual(replacement);
    } finally {
      request.resolve(Response.json({}));
      await refreshing.catch(() => undefined);
      fetchMock.mockRestore();
    }
  });

  it("reuses credentials saved by another window while the original quota request was awaiting its 401", async () => {
    const original = tokens("quota-original");
    const replacement = tokens("quota-replacement");
    secrets.set("codex.account.fixture", JSON.stringify(original));
    const owner = repository();
    vi.spyOn(owner, "refreshSubscriptionState").mockResolvedValue(undefined);
    vi.spyOn(owner, "refreshResetCreditInventory").mockResolvedValue(undefined);
    const unauthorized = defer<Response>();
    const quotaTokens: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url) === RESET_CREDITS_URL) {
        return Response.json({ available_count: 0, credits: [] });
      }
      expect(String(url)).toBe(QUOTA_USAGE_URL);
      const headers = new Headers(init?.headers);
      expect(headers.get("ChatGPT-Account-Id")).toBe("acct-fixture");
      quotaTokens.push(headers.get("Authorization") ?? "");
      return quotaTokens.length === 1
        ? unauthorized.promise
        : Response.json({ rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18000 } } });
    });

    const result = refreshSingleQuota(owner, { refresh: vi.fn() }, "fixture", { announce: false, warnQuota: false });
    try {
      await vi.waitFor(() => expect(quotaTokens).toEqual([`Bearer ${original.accessToken}`]));
      await repository().updateTokens("fixture", replacement);
      unauthorized.resolve(Response.json({ detail: { code: "token_expired" } }, { status: 401 }));

      await expect(result).resolves.toBe(true);
      expect(quotaTokens).toEqual([`Bearer ${original.accessToken}`, `Bearer ${replacement.accessToken}`]);
      expect(refresh).not.toHaveBeenCalled();
      expect(await repository().getTokens("fixture", { syncExternal: false })).toEqual(replacement);
      expect((await owner.getAccount("fixture"))?.quotaSummary?.hourlyPercentage).toBe(70);
    } finally {
      unauthorized.resolve(new Response(null, { status: 401 }));
      await result.catch(() => undefined);
      fetchMock.mockRestore();
    }
  });

  it.each(["organization", "explicit accountId"])("rejects a conflicting OAuth renewal (%s) before it changes credentials", async (conflict) => {
    const withOrganization = (credential: CodexTokens, organizationId: string): CodexTokens => {
      const payload = Buffer.from(JSON.stringify({
        email: "fixture@example.test",
        exp: Math.floor(Date.now() / 1000) + 3600,
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-fixture", organization_id: organizationId }
      })).toString("base64url");
      return { ...credential, accessToken: `header.${payload}.fixture` };
    };
    const original = withOrganization(tokens("scoped-original"), "org-original");
    const conflicting = conflict === "organization"
      ? withOrganization(tokens("scoped-conflict"), "org-other")
      : { ...withOrganization(tokens("scoped-conflict"), "org-original"), accountId: "acct-other" };
    secrets.set("codex.account.fixture", JSON.stringify(original));
    const persistedAuth = mockPersistedAuth(original);
    refresh.mockResolvedValueOnce(conflicting);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      expect(String(url)).toBe(QUOTA_USAGE_URL);
      return Response.json({ detail: { code: "token_expired" } }, { status: 401 });
    });
    const owner = repository();

    try {
      await expect(refreshSingleQuota(owner, { refresh: vi.fn() }, "fixture", { announce: false, warnQuota: false }))
        .rejects.toThrow("workspace changed during token refresh");
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(secrets.get("codex.account.fixture")).toBe(JSON.stringify(original));
      expect(writeAuth).not.toHaveBeenCalled();
      expect(persistedAuth()).toEqual(authForTokens(original));
      const saved = await owner.getAccount("fixture");
      expect(saved?.accountId).toBe("acct-fixture");
      expect(saved?.quotaError).toBeUndefined();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("keeps a repaired workspace as quota scope when OAuth does not replace a historical account ID hint", async () => {
    const original = tokens("legacy-original", false, "legacy");
    const renewed = { ...tokens("legacy-updated", false, "legacy"), accountId: undefined };
    secrets.set("codex.account.fixture", JSON.stringify(original));
    refresh.mockResolvedValueOnce(renewed);
    const persistedAuth = mockPersistedAuth(original);
    const owner = repository();
    vi.spyOn(owner, "refreshSubscriptionState").mockResolvedValue(undefined);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(String(url)).toBe(QUOTA_USAGE_URL);
      expect(new Headers(init?.headers).get("ChatGPT-Account-Id")).toBe("acct-fixture");
      return new Response(null, { status: 401 });
    });

    try {
      await expect(refreshSingleQuota(owner, { refresh: vi.fn() }, "fixture", { announce: false, warnQuota: false }))
        .resolves.toBe(false);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((await owner.getAccount("fixture"))?.accountId).toBe("acct-fixture");
      expect(JSON.parse(secrets.get("codex.account.fixture")!)).toEqual({ ...renewed, accountId: "acct-fixture" });
      expect(persistedAuth().tokens?.account_id).toBe("acct-fixture");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("keeps the new active account when deletion of the former account commits last", async () => {
    const entered = defer<void>();
    const resume = defer<void>();
    context.secrets.delete = async (key) => {
      entered.resolve();
      await resume.promise;
      secrets.delete(key);
    };
    secrets.set("codex.account.backup", JSON.stringify(tokens("backup", false, "backup")));
    const removing = repository().removeAccount("fixture");
    await entered.promise;
    try {
      await repository().switchAccount("backup");
      expect((await repository().getAccount("backup"))?.isActive).toBe(true);
    } finally {
      resume.resolve();
      await removing;
    }
    expect(await repository().getAccount("fixture")).toBeUndefined();
    expect(writeAuth.mock.calls.map(([value]) => value.accountId)).toEqual(["acct-backup"]);
    expect((await repository().getAccount("backup"))?.isActive).toBe(true);
  });

  it("keeps the reset-credit expiry when a concurrent quota result omitted it", async () => {
    const original = JSON.parse(secrets.get("codex.account.fixture")!) as CodexTokens;
    const owner = repository();
    await owner.updateQuota("fixture", {
      hourlyPercentage: 70,
      weeklyPercentage: 80,
      hourlyWindowPresent: true,
      hourlyWindowMinutes: 300,
      resetCreditsAvailable: 1
    });
    const { repo: quotaWindow, entered, resume } = pauseCredentialRead();
    const quota = quotaWindow.updateQuota(
      "fixture",
      {
        hourlyPercentage: 40,
        weeklyPercentage: 80,
        hourlyWindowPresent: true,
        hourlyWindowMinutes: 300,
        resetCreditsAvailable: 1
      },
      undefined,
      undefined,
      undefined,
      undefined,
      original
    );
    await entered;
    const expiry = Math.floor(Date.now() / 1000) + 600;
    try {
      await owner.updateResetCreditsSnapshot("fixture", 1, expiry);
      expect((await owner.getAccount("fixture"))?.quotaSummary?.resetCreditsNextExpiresAt).toBe(expiry);
    } finally {
      resume();
      await quota;
    }
    expect((await owner.getAccount("fixture"))?.quotaSummary).toMatchObject({
      hourlyPercentage: 40,
      resetCreditsNextExpiresAt: expiry
    });
  });

  it("mirrors current account tags when a refresh races with a user's edit", async () => {
    const { repo: quotaWindow, entered, resume } = pauseCredentialRead();
    const quota = quotaWindow.updateQuota("fixture", { hourlyPercentage: 40, weeklyPercentage: 80 });
    await entered;
    const mirrorPath = getAideckCodexAccountFilePath("fixture");
    try {
      await repository().setAccountTags("fixture", ["keep"]);
      expect(JSON.parse(await fs.readFile(mirrorPath, "utf8")).tags).toEqual(["keep"]);
    } finally {
      resume();
      await quota;
    }
    expect((await repository().getAccount("fixture"))?.tags).toEqual(["keep"]);
    expect(JSON.parse(await fs.readFile(mirrorPath, "utf8")).tags).toEqual(["keep"]);
  });

  it("keeps the edited AiDeck tags when an in-flight renewal publishes new credentials", async () => {
    const { repo, entered, resume } = pauseCredentialRead();
    const renewed = tokens("renewed");
    const renewal = repo.updateTokens("fixture", renewed);
    await entered;
    try {
      await repository().setAccountTags("fixture", ["keep"]);
    } finally {
      resume();
      await renewal;
    }
    const mirror = JSON.parse(await fs.readFile(getAideckCodexAccountFilePath("fixture"), "utf8"));
    expect(mirror.tags).toEqual(["keep"]);
    expect(mirror.tokens.refresh_token).toBe(renewed.refreshToken);
  });

  it("can initialize with a readable credential file in a read-only Codex home", async () => {
    const authDirectory = path.join(directory, "readonly-codex");
    await fs.mkdir(authDirectory);
    const current = tokens("original");
    const accountId = buildAccountStorageId("fixture@example.test", current.accountId, undefined);
    const saved = (await repository().getAccount("fixture"))!;
    await fs.writeFile(
      path.join(directory, "accounts-index.json"),
      JSON.stringify({
        accounts: [{ ...saved, id: accountId, isActive: false }]
      })
    );
    const auth = {
      OPENAI_API_KEY: null,
      tokens: {
        id_token: current.idToken,
        access_token: current.accessToken,
        refresh_token: current.refreshToken,
        account_id: current.accountId
      }
    };
    const file = path.join(authDirectory, "auth.json");
    await fs.writeFile(file, JSON.stringify(auth), { mode: 0o600 });
    authPath.mockReturnValue(file);
    readAuth.mockResolvedValue(auth);
    if (process.platform !== "win32") {
      await fs.chmod(authDirectory, 0o500);
    }
    try {
      const repo = repository();
      await repo.init();
      expect(await fs.readdir(authDirectory)).toEqual(["auth.json"]);
      expect((await repo.getAccount(accountId))?.isActive).toBe(true);
      expect(await repo.getTokens(accountId, { syncExternal: false })).toEqual(current);
      expect(await fs.readdir(path.join(directory, ".codex-accounts-manager"))).toContain("auth-locks");
      expect(writeAuth).not.toHaveBeenCalled();
    } finally {
      if (process.platform !== "win32") {
        await fs.chmod(authDirectory, 0o700);
      }
    }
  });

  it("does not overwrite the new active account when an old window finishes renewing the previous account", async () => {
    const pending = defer<CodexTokens>();
    refresh.mockReturnValue(pending.promise);
    secrets.set("codex.account.backup", JSON.stringify(tokens("backup", false, "backup")));
    const renewal = repository().getFreshTokens("fixture");
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await repository().switchAccount("backup");
    const renewed = tokens("renewed");
    pending.resolve(renewed);
    expect(await renewal).toEqual(renewed);
    expect(writeAuth.mock.calls.map(([value]) => value.accountId)).toEqual(["acct-backup"]);
    expect((await repository().getAccount("backup"))?.isActive).toBe(true);
  });

  it("preserves independent account settings saved by two windows", async () => {
    const first = repository();
    const second = repository();
    await second.listAccounts();
    await first.setAccountTags("fixture", ["keep"]);
    first.dispose();
    await second.setStatusBarVisibility("backup", true);
    second.dispose();
    const records = await repository().listAccounts();
    expect(records.find((account) => account.id === "fixture")?.tags).toEqual(["keep"]);
    expect(records.find((account) => account.id === "backup")?.showInStatusBar).toBe(true);
  });

  it("keeps both edits when two windows add tags to the same account concurrently", async () => {
    await Promise.all([
      repository().addAccountTags(["fixture"], ["one"]),
      repository().addAccountTags(["fixture"], ["two"])
    ]);
    expect((await repository().getAccount("fixture"))?.tags).toEqual(expect.arrayContaining(["one", "two"]));
  });

  it("uses the current auth file even when a different VS Code profile still has the old account selected", async () => {
    const pending = defer<CodexTokens>();
    refresh.mockReturnValue(pending.promise);
    const renewal = repository().getFreshTokens("fixture");
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    const other = tokens("different-profile", false, "backup");
    readAuth.mockResolvedValue({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: other.idToken,
        access_token: other.accessToken,
        refresh_token: other.refreshToken,
        account_id: other.accountId
      }
    });
    pending.resolve(tokens("renewed"));

    await renewal;
    expect(writeAuth).not.toHaveBeenCalled();
  });

  it("does not rewrite active credentials during a quota refresh with unchanged tokens", async () => {
    const repo = repository();
    const original = await repo.getTokens("fixture");
    await repo.updateQuota("fixture", undefined, undefined, original, undefined, undefined, original);
    expect(writeAuth).not.toHaveBeenCalled();
  });

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

  it("does not recreate auth.json when the user signs out during renewal", async () => {
    const original = tokens("disk-current", true);
    const active = await seedAccountForTokens(original);
    const authFile = path.join(directory, "auth.json");
    await fs.writeFile(authFile, JSON.stringify(authForTokens(original)), { mode: 0o600 });
    readAuth.mockResolvedValue(authForTokens(original));
    writeAuth.mockImplementation(async (credentials: CodexTokens) => {
      await fs.writeFile(authFile, JSON.stringify(authForTokens(credentials)), { mode: 0o600 });
    });
    const pending = defer<CodexTokens>();
    const renewed = tokens("renewed");
    refresh.mockReturnValue(pending.promise);
    const renewing = repository().getFreshTokens(active.id);

    try {
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledExactlyOnceWith(original.refreshToken, original.idToken));
      await fs.rm(authFile);
      readAuth.mockResolvedValue(undefined);
      expect(await repository().getAccount(active.id)).toMatchObject({ isActive: true });
    } finally {
      pending.resolve(renewed);
      await renewing;
    }

    expect(await renewing).toEqual(renewed);
    expect(await repository().getTokens(active.id, { syncExternal: false })).toEqual(renewed);
    expect(writeAuth).not.toHaveBeenCalled();
    await expect(fs.stat(authFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not re-import a deleted account from an earlier startup mirror snapshot", async () => {
    const credentials = tokens("mirror");
    const active = await seedAccountForTokens(credentials);
    await mirrorAideckCodexAccount(active, credentials);
    const mirrorFile = getAideckCodexAccountFilePath(active.id);
    const captured = defer<number>();
    const resume = defer<void>();
    afterMirrorSnapshot.mockImplementationOnce(async (entryCount) => {
      captured.resolve(entryCount);
      await resume.promise;
    });
    const initializing = repository().init();
    try {
      const entryCount = await Promise.race([captured.promise, initializing.then(() => 0)]);
      expect(entryCount).toBe(1);
      await repository().removeAccount(active.id);
      expect(await repository().getAccount(active.id)).toBeUndefined();
      await expect(fs.stat(mirrorFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      resume.resolve();
      await initializing;
    }

    expect(await repository().getAccount(active.id)).toBeUndefined();
    expect(secrets.has(`codex.account.${active.id}`)).toBe(false);
    await expect(fs.stat(mirrorFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not restore credentials from an AiDeck mirror read during account deletion", async () => {
    const active = (await repository().getAccount("fixture"))!;
    await mirrorAideckCodexAccount(active, tokens("mirror"));
    const { repo: owner, deleted, resume } = pauseAfterSecretDeletion();
    const removing = owner.removeAccount(active.id);
    await deleted;
    const refreshing = repository().getFreshTokens(active.id);
    try {
      await vi.waitFor(() => {
        expect(lockRequested.mock.calls.filter(([key]) => key === `write:${active.id}`)).toHaveLength(2);
      });
    } finally {
      resume();
      await removing;
    }

    expect(await refreshing).toBeUndefined();
    expect(await repository().getAccount(active.id)).toBeUndefined();
    expect(secrets.has(`codex.account.${active.id}`)).toBe(false);
  });

  it("does not hydrate auth credentials from a watcher that overlaps account deletion", async () => {
    const credentials = tokens("disk");
    const active = await seedAccountForTokens(credentials);
    readAuth.mockResolvedValue(authForTokens(credentials));
    const { repo: owner, deleted, resume } = pauseAfterSecretDeletion();
    const removing = owner.removeAccount(active.id);
    await deleted;
    const syncing = repository().syncActiveAccountFromAuthFile();
    try {
      await vi.waitFor(() => {
        expect(lockRequested.mock.calls.filter(([key]) => key === `write:${active.id}`)).toHaveLength(2);
      });
    } finally {
      resume();
      await removing;
    }

    await syncing;
    expect(await repository().getAccount(active.id)).toBeUndefined();
    expect(secrets.has(`codex.account.${active.id}`)).toBe(false);
  });

  it("recreates a deleted account when an explicit import acquires its write lock after deletion", async () => {
    const active = await seedAccountForTokens(tokens("original"));
    const { repo: owner, deleted, resume } = pauseAfterSecretDeletion();
    const removing = owner.removeAccount(active.id);
    await deleted;
    const importedCredentials = tokens("explicit-import");
    const importing = repository().upsertFromTokens(importedCredentials);
    try {
      await vi.waitFor(() => {
        expect(lockRequested.mock.calls.filter(([key]) => key === `write:${active.id}`)).toHaveLength(2);
      });
    } finally {
      resume();
      await removing;
    }

    const imported = await importing;
    expect(imported.id).toBe(active.id);
    const reopened = repository();
    expect(await reopened.getAccount(active.id)).toMatchObject({
      id: active.id,
      email: active.email,
      isActive: false
    });
    expect(await reopened.getTokens(active.id, { syncExternal: false })).toEqual(importedCredentials);
  });

  it("keeps renewed AiDeck credentials when another window later synchronizes active auth", async () => {
    const older = tokens("disk-old", true);
    const active = await seedAccountForTokens(older);
    const readDisk = mockPersistedAuth(older);
    const mirror = tokens("aideck-newer");
    await mirrorAideckCodexAccount(active, mirror);
    const renewed = tokens("renewed");
    refresh.mockResolvedValue(renewed);

    expect(await repository().getFreshTokens(active.id, { force: true })).toEqual(renewed);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(mirror.refreshToken, mirror.idToken);
    const watcher = repository();
    await watcher.syncActiveAccountFromAuthFile();

    expect(await watcher.getTokens(active.id, { bypassCache: true, syncExternal: false })).toEqual(renewed);
    expect(readDisk().tokens?.refresh_token).toBe(renewed.refreshToken);
  });

  it("preserves already-adopted credentials during sync and renews an older auth file", async () => {
    const now = Math.floor(Date.now() / 1000);
    const older = tokens("disk-old", false, "fixture", now - 60);
    const adopted = tokens("aideck-adopted", false, "fixture", now - 30);
    const active = await seedAccountForTokens(adopted);
    const readDisk = mockPersistedAuth(older);
    await mirrorAideckCodexAccount(active, adopted);
    const watcher = repository();
    await watcher.syncActiveAccountFromAuthFile();
    expect(await watcher.getTokens(active.id, { bypassCache: true, syncExternal: false })).toEqual(adopted);
    expect(writeAuth).not.toHaveBeenCalled();

    const renewed = tokens("renewed", false, "fixture", now);
    refresh.mockResolvedValue(renewed);

    expect(await repository().getFreshTokens(active.id, { force: true })).toEqual(renewed);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(adopted.refreshToken, adopted.idToken);
    expect(writeAuth).toHaveBeenCalledExactlyOnceWith(renewed);
    expect(readDisk().tokens?.refresh_token).toBe(renewed.refreshToken);
  });
});
